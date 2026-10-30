"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { routes } from "@/lib/routes";
import { ButtonLink, EmptyState } from "@/components/ui";
import { jobListBucket } from "@/lib/job-progress";
import { debounce } from "@/lib/ui/debounce";
import { startVisibleInterval } from "@/lib/ui/visible-interval";
import { ACTIVE_JOB_REFRESH_MS } from "@/lib/ui/refresh-intervals";
import { JobListItem } from "./JobListItem";

export interface JobRow {
  id: string;
  job_number: string;
  original_file_name: string;
  status: string;
  source_pdf_pages: number;
  color_mode: string;
  duplex: boolean;
  copies: number;
  policy_action: string | null;
  policy_reasons: string[];
  error_message: string | null;
  /** Why a held job is waiting for its sender's choices (print_jobs.held_reason). */
  held_reason: string | null;
  /** An admin-issued queue test rather than a document someone chose to print
   *  (app/admin/printers/actions.ts) - flagged on the row so it can't be
   *  mistaken for one. */
  is_test_print: boolean;
  /** Set once retention deleted the stored file - "Print again" can no longer work. */
  files_purged_at?: string | null;
  created_at: string;
  updated_at: string;
}

type Filter = "all" | "active" | "attention" | "done";

export function JobsList({
  initialJobs,
  eventTypesByJob,
  userId,
}: {
  initialJobs: JobRow[];
  /** job id -> its print_job_events event types, oldest first (see jobs/page.tsx). */
  eventTypesByJob: Record<string, string[]>;
  userId: string;
}) {
  const router = useRouter();
  /** Rows straight off the realtime channel, merged over the server's list below. */
  const [liveRows, setLiveRows] = useState<Record<string, JobRow>>({});
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  /**
   * The server render stays authoritative: a realtime row is only preferred
   * while it is genuinely newer than the row the server sent (print_jobs has
   * a set_updated_at trigger, so updated_at always moves). That way a
   * router.refresh() landing late can never roll a row back to an older
   * status, and no state has to be re-synced from an effect.
   */
  const jobs = useMemo(() => {
    const removed = new Set(removedIds);
    const byId = new Map<string, JobRow>();
    for (const job of initialJobs) if (!removed.has(job.id)) byId.set(job.id, job);
    for (const [id, row] of Object.entries(liveRows)) {
      if (removed.has(id)) continue;
      const server = byId.get(id);
      if (!server || Date.parse(row.updated_at) > Date.parse(server.updated_at)) byId.set(id, row);
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [initialJobs, liveRows, removedIds]);

  /**
   * Same live-update mechanism as the job detail page and the realtime
   * approval queue: Supabase Realtime `postgres_changes` on print_jobs,
   * filtered to this user's own rows, with visibility still enforced by the
   * table's RLS policy (docs/architecture.md sec 3.4/15). The row in the
   * payload is applied straight away so a status change is instant, and
   * router.refresh() re-runs the page so anything the server derives stays
   * in step.
   *
   * `.subscribe()` itself is async - establishing the websocket/join
   * handshake takes a real, variable amount of time, and any change to a row
   * that happens before it completes is missed entirely (no error, no
   * replay). That window is exactly the one that bit a real user: navigating
   * straight to a freshly-created job whose Agent was mid-poll-cycle already,
   * so it claimed and failed the job within the same second or two the page
   * was still connecting. Waiting for the "SUBSCRIBED" callback and firing
   * one router.refresh() at that moment closes the gap - it re-syncs with
   * whatever the server already has the instant we know we'd otherwise start
   * missing live updates, at the cost of one extra refresh per page load.
   */
  useEffect(() => {
    const supabase = createClient();
    // Realtime bursts (a job moving through several statuses) collapse into one server re-render.
    const refreshSoon = debounce(() => router.refresh(), 2_000);
    const channel = supabase
      .channel(`jobs-own-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "print_jobs", filter: `created_by=eq.${userId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            // No RLS delete policy exists for print_jobs today (jobs are
            // retired via status), but handle it rather than leaving a ghost
            // row on screen if that ever changes.
            const gone = (payload.old as Partial<JobRow>).id;
            if (gone) setRemovedIds((prev) => (prev.includes(gone) ? prev : [...prev, gone]));
          } else {
            const row = payload.new as JobRow;
            setLiveRows((prev) => ({ ...prev, [row.id]: row }));
          }
          refreshSoon();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") router.refresh();
      });

    return () => {
      refreshSoon.cancel();
      supabase.removeChannel(channel);
    };
  }, [userId, router]);

  // Guaranteed backstop, independent of Realtime - see the identical comment
  // in JobStatusLive.tsx for why this exists (a job updated without ever
  // arriving live, well past any handshake window). Polls only while at
  // least one row is still actually moving.
  const anyActive = useMemo(() => jobs.some((j) => jobListBucket(j.status) === "active"), [jobs]);
  useEffect(() => {
    if (!anyActive) return;
    return startVisibleInterval(() => router.refresh(), ACTIVE_JOB_REFRESH_MS, document);
  }, [anyActive, router]);

  const counts = useMemo(() => {
    const next = { all: jobs.length, active: 0, attention: 0, done: 0 };
    for (const job of jobs) {
      const bucket = jobListBucket(job.status);
      if (bucket !== "other") next[bucket] += 1;
    }
    return next;
  }, [jobs]);

  const visible = useMemo(
    () => (filter === "all" ? jobs : jobs.filter((j) => jobListBucket(j.status) === filter)),
    [jobs, filter],
  );

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No print jobs yet"
        description="When you print something, it shows up here so you can follow it."
        icon={FileText}
        action={
          <ButtonLink href={routes.print} size="lg">
            Print your first document
          </ButtonLink>
        }
      />
    );
  }

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "active", label: "In progress", count: counts.active },
    { id: "attention", label: "Needs attention", count: counts.attention },
    { id: "done", label: "Done", count: counts.done },
  ];

  return (
    <>
      <div
        role="group"
        aria-label="Filter jobs"
        className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:min-h-9 sm:px-3.5 ${
              filter === f.id
                ? "border-[var(--color-text)] bg-[var(--color-text)] text-white"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-2)] hover:border-[var(--color-border-strong)]"
            } ${f.count === 0 && f.id !== "all" ? "opacity-55" : ""}`}
          >
            {f.label}
            <span className={`text-xs tabular-nums ${filter === f.id ? "text-white/70" : "text-[var(--color-faint)]"}`}>
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState message="No jobs in this view." icon={FileText} />
      ) : (
        <ul className="flex flex-col gap-3" data-tour="jobs-list-container">
          {visible.map((job) => (
            <JobListItem key={job.id} job={job} eventTypes={eventTypesByJob[job.id]} />
          ))}
        </ul>
      )}
    </>
  );
}
