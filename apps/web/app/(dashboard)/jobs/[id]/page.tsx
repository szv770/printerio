import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { Card } from "@/components/ui";
import { jobEventDisplay } from "@/lib/job-event-labels";
import { formatFileSize } from "@/lib/pdf/client-precheck";
import { canOwnerPurgeFiles } from "@/lib/retention";
import { JobStatusLive } from "./JobStatusLive";
import { ReprintButton } from "./ReprintButton";
import { DeleteFileButton } from "./DeleteFileButton";
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

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-semibold">{job.original_file_name}</h1>
          <p className="text-sm text-[var(--color-muted)]">{job.job_number}</p>
        </div>
        {/* Three things have to hold for "Print again" to be offerable at all:
         *  - it re-runs the ordinary submission pipeline (policy, quota and
         *    all), so it is deliberately not offered for a test print, which
         *    would silently become a real, quota-charged job - another test
         *    print is sent from Admin → Printers instead;
         *  - it re-runs that pipeline against the ORIGINAL stored bytes, so a
         *    job whose file has been purged (retention, or the owner deleting
         *    it below) can only fail;
         *  - it is scoped to the job's own submitter server-side, so it is
         *    pointless for an approver looking at someone else's job. */}
        {!job.is_test_print && isOwner && !job.files_purged_at && <ReprintButton jobId={job.id} />}
      </div>

      {/* The stage-by-stage answer to "where is this up to right now", live
       *  over Supabase Realtime. It also owns the "why" for a job that
       *  stopped (denial reasons, the approver's reason, the agent's error
       *  message) and the reasons a job needed approval in the first place -
       *  those read as part of the stage they belong to, rather than as a
       *  separate card floating above the details. */}
      <JobStatusLive job={job} eventTypes={eventRows.map((e) => e.event_type)} rejectionReason={rejectionReasonFrom(eventRows)} />

      <Card className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[var(--color-muted)]">Pages</p>
          <p className="font-medium">{job.source_pdf_pages}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Copies</p>
          <p className="font-medium">{job.copies}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Color</p>
          <p className="font-medium">{job.color_mode === "color" ? "Color" : "B&W"}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Sides</p>
          <p className="font-medium">{job.duplex ? "Double-sided" : "Single-sided"}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Printed sides</p>
          <p className="font-medium">{job.estimated_printed_sides}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Physical sheets</p>
          <p className="font-medium">{job.estimated_physical_sheets}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">File size</p>
          <p className="font-medium">{formatFileSize(Number(job.file_size_bytes))}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Stored file</p>
          <p className="font-medium">
            {job.files_purged_at ? (
              <>
                Deleted <LocalTime iso={job.files_purged_at} />
              </>
            ) : (
              "Kept for now"
            )}
          </p>
        </div>
      </Card>

      {/* Only the submitter, only once the job has genuinely finished, and
       *  only while a file is actually there - the action re-checks all three
       *  server-side (lib/retention.ts's canOwnerPurgeFiles); this just keeps
       *  the control from appearing when it could not possibly work. */}
      {isOwner && !job.files_purged_at && canOwnerPurgeFiles(job).ok && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-[var(--color-muted)]">
            Your uploaded PDF is stored until this organization&apos;s retention window ends. You can remove it now
            instead - the job record and its history are kept either way.
          </p>
          <DeleteFileButton jobId={job.id} />
        </div>
      )}

      {eventRows.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-medium">History</p>
          {/* Detail under the stepper, not instead of it: the stepper says
           *  where the job is, this says exactly what happened and when.
           *  Plain-English labels, not the raw print_job_events.event_type
           *  pipeline constants - see lib/job-event-labels.ts. */}
          <ul className="flex flex-col gap-1.5 text-xs text-[var(--color-muted)]">
            {eventRows.map((e) => {
              const { Icon, label } = jobEventDisplay(e.event_type);
              return (
                <li key={e.id} className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="text-[var(--color-text)]">{label}</span>
                  <LocalTime iso={e.created_at} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </main>
  );
}
