"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCheck2, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { routes } from "@/lib/routes";
import { Badge, EmptyState } from "@/components/ui";
import { jobAttentionLine, jobListBucket } from "@/lib/job-progress";
import { ReprintButton } from "./[id]/ReprintButton";
import { JobStatusBadge } from "./JobStatusBadge";
import { JobProgressBar } from "./JobProgressBar";
import { LocalTime } from "./LocalTime";

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
  /** An admin-issued queue test rather than a document someone chose to print
   *  (app/admin/printers/actions.ts) - flagged on the row so it can't be
   *  mistaken for one. */
  is_test_print: boolean;
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
          router.refresh();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") router.refresh();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, router]);

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
        message="No print jobs yet."
        icon={FileText}
        action={
          <Link
            href={routes.print}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
          >
            + Print your first document
          </Link>
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
      <div className="mb-4 flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`rounded-full border px-3 py-1 text-sm ${
              filter === f.id
                ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-primary)]"
            } ${f.count === 0 && f.id !== "all" ? "opacity-50" : ""}`}
          >
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState message="No jobs in this view." icon={FileText} />
      ) : (
        <ul className="flex flex-col gap-3" data-tour="jobs-list-container">
          {visible.map((job) => {
            const attention = jobAttentionLine({
              status: job.status,
              errorMessage: job.error_message,
              policyReasons: job.policy_reasons,
            });
            return (
              <li
                key={job.id}
                className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-primary)]"
              >
                <Link href={routes.job(job.id)} className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{job.original_file_name}</span>
                      {job.is_test_print && (
                        <Badge tone="neutral">
                          <span className="flex items-center gap-1">
                            <FileCheck2 className="h-3 w-3" /> Test print
                          </span>
                        </Badge>
                      )}
                    </span>
                    <JobStatusBadge status={job.status} />
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {job.job_number} • {job.source_pdf_pages} pages • {job.color_mode === "color" ? "Color" : "B&W"} •{" "}
                    {job.duplex ? "Duplex" : "Simplex"} • {job.copies} {job.copies === 1 ? "copy" : "copies"} •{" "}
                    <LocalTime iso={job.created_at} />
                  </p>
                  <div className="mt-2">
                    <JobProgressBar
                      status={job.status}
                      policyAction={job.policy_action}
                      eventTypes={eventTypesByJob[job.id]}
                      isTestPrint={job.is_test_print}
                    />
                  </div>
                  {attention && <p className="mt-1 truncate text-xs text-[var(--color-danger)]">{attention}</p>}
                </Link>
                {/* Reprinting re-runs the ordinary pipeline (policy + quota),
                 *  so it is not offered for a test print - see the job detail
                 *  page for the same reasoning. */}
                {!job.is_test_print && <ReprintButton jobId={job.id} />}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
