import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText, History } from "lucide-react";
import { routes } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { Collapsible } from "@/components/ui";
import { jobEventDisplay } from "@/lib/job-event-labels";
import { formatFileSize } from "@/lib/pdf/client-precheck";
import { canOwnerPurgeFiles } from "@/lib/retention";
import { JobStatusLive } from "./JobStatusLive";
import { ReprintButton } from "./ReprintButton";
import { DeleteFileButton } from "./DeleteFileButton";
import { CancelJobButton } from "./CancelJobButton";
import { RetryJobButton } from "./RetryJobButton";
import { jobActionPlan } from "@/lib/jobs/action-plan";
import { LocalTime } from "../LocalTime";

/** The approver's own words, recorded on the REJECTED event alongside the
 *  approval_actions row (app/admin/approvals/actions.ts). Read from the
 *  events we already fetched rather than a second query - both are visible to
 *  the job's owner under the same RLS policy. */
function rejectionReasonFrom(events: { event_type: string; metadata: unknown }[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.event_type !== "REJECTED") continue;
    const reason = (event.metadata as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;
  }
  return null;
}

/** Plain words for what was asked for, from the per-job fields (older jobs have no corner / side stored). */
function finishingLabel(job: { finishing: unknown; staple_position: string | null; booklet_binding_side: string | null }): string {
  const f = job.finishing as { staple?: boolean; booklet?: boolean; punch?: boolean } | null;
  const parts: string[] = [];
  if (f?.booklet) parts.push(job.booklet_binding_side ? `Booklet, bound on the ${job.booklet_binding_side}` : "Booklet");
  if (f?.staple) parts.push(job.staple_position ? `Stapled ${job.staple_position}` : "Stapled");
  if (f?.punch) parts.push("Hole punch");
  return parts.length > 0 ? parts.join(", ") : "None";
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // RLS below still governs actual row visibility; the session is read here
  // so the page can tell whether the viewer is the job's own submitter (an
  // approver can see the row too, but only the owner may delete its file).
  const session = await requireSessionOrRedirect();

  const supabase = await createClient();
  const { data: job } = await supabase.from("print_jobs").select("*").eq("id", id).maybeSingle();
  if (!job) notFound();
  const isOwner = job.created_by === session.userId;

  const { data: events } = await supabase
    .from("print_job_events")
    .select("*")
    .eq("job_id", id)
    .order("created_at", { ascending: true });
  const eventRows = events ?? [];


  const plan = jobActionPlan({
    status: job.status,
    isOwner,
    isTestPrint: job.is_test_print,
    filesPurged: !!job.files_purged_at,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
  });
  const canDeleteFile = isOwner && !job.files_purged_at && canOwnerPurgeFiles(job).ok;
  const lastEvent = eventRows.length > 0 ? jobEventDisplay(eventRows[eventRows.length - 1]!.event_type).label : null;

  // Owner-only controls. Cancel is offered only while nothing has been sent to the print agent (the server
  // re-checks and says so plainly if the job slipped away); "Try again" re-queues THIS job after a failure while
  // tries remain. "Print again" re-runs the ordinary submission pipeline (policy, quota and all) against the
  // ORIGINAL stored bytes, so it is not offered for a test print (that would silently become a real, quota-charged
  // job), for a job whose file was purged, or to anyone but the job's own submitter.
  const actions =
    plan.retry || plan.cancel || plan.reprint || plan.atPrinter ? (
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
        {plan.retry && <RetryJobButton jobId={job.id} big />}
        {plan.reprint && <ReprintButton jobId={job.id} big primary={plan.reprintPrimary} />}
        {plan.cancel && <CancelJobButton jobId={job.id} big />}
        {plan.atPrinter && (
          <p className="text-sm text-[var(--color-muted)]">This job has already gone to the printer. Clear it at the printer.</p>
        )}
      </div>
    ) : null;

  const detail = (label: string, value: React.ReactNode) => (
    <div key={label}>
      <dt className="text-[13px] text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium">{value}</dd>
    </div>
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <Link
        href={routes.jobs}
        className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        My jobs
      </Link>

      <div className="mb-5">
        <h1 className="break-words text-xl font-semibold leading-7 sm:text-2xl sm:leading-8">{job.original_file_name}</h1>
        <p className="mt-0.5 text-sm text-[var(--color-muted)]">
          {job.job_number} · Sent <LocalTime iso={job.created_at} />
        </p>
      </div>

      {/* The answer to "where is this up to right now", live over Supabase Realtime. It also owns the "why" for a
       *  job that stopped (denial reasons, the approver's reason, the agent's error message) and the reasons a job
       *  needed approval in the first place. */}
      <JobStatusLive
        job={job}
        eventTypes={eventRows.map((e) => e.event_type)}
        rejectionReason={rejectionReasonFrom(eventRows)}
        actions={actions}
      />

      <div className="mt-4 flex flex-col gap-3">
        <Collapsible
          id="job-details"
          title="Details"
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
          summary={`${job.source_pdf_pages} ${job.source_pdf_pages === 1 ? "page" : "pages"} · ${job.copies} ${job.copies === 1 ? "copy" : "copies"} · ${job.duplex ? "double-sided" : "single-sided"}`}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            {detail("Pages", job.source_pdf_pages)}
            {job.page_range && detail("Page range", job.page_range)}
            {detail("Copies", job.copies)}
            {detail("Sides", job.duplex ? "Double-sided" : "Single-sided")}
            {detail("Finishing", finishingLabel(job))}
            {detail("Color", job.color_mode === "color" ? "Color" : "Black & white")}
            {detail("Printed sides", job.estimated_printed_sides)}
            {detail("Sheets of paper", job.estimated_physical_sheets)}
            {detail("File size", formatFileSize(Number(job.file_size_bytes)))}
            {detail(
              "Stored file",
              job.files_purged_at ? (
                <>
                  Deleted <LocalTime iso={job.files_purged_at} />
                </>
              ) : (
                "Kept for now"
              ),
            )}
          </dl>

          {/* Only the submitter, only once the job has genuinely finished, and only while a file is actually there
           *  - the action re-checks all three server-side (lib/retention.ts canOwnerPurgeFiles); this just keeps
           *  the control from appearing when it could not possibly work. */}
          {canDeleteFile && (
            <div className="mt-5 border-t border-[var(--color-border)] pt-4">
              <p className="mb-3 text-[13px] text-[var(--color-muted)]">
                Your PDF is stored until this organization&apos;s retention window ends. You can remove it now instead. The job and its history stay either
                way.
              </p>
              <DeleteFileButton jobId={job.id} />
            </div>
          )}
        </Collapsible>

        {eventRows.length > 0 && (
          <Collapsible
            id="job-history"
            title="History"
            icon={<History className="h-4 w-4" aria-hidden="true" />}
            summary={`${eventRows.length} ${eventRows.length === 1 ? "step" : "steps"}${lastEvent ? ` · latest: ${lastEvent}` : ""}`}
          >
            {/* Detail under the step list, not instead of it: that says where the job is, this says exactly what
             *  happened and when. Plain-English labels, not the raw print_job_events.event_type constants. */}
            <ul className="flex flex-col gap-3 text-sm">
              {eventRows.map((e) => {
                const { Icon, label } = jobEventDisplay(e.event_type);
                return (
                  <li key={e.id} className="flex items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[var(--color-muted)]">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 font-medium">{label}</span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">
                      <LocalTime iso={e.created_at} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </Collapsible>
        )}
      </div>
    </main>
  );
}
