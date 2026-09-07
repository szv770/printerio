import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { Card } from "@/components/ui";
import { jobEventDisplay } from "@/lib/job-event-labels";
import { JobStatusLive } from "./JobStatusLive";
import { ReprintButton } from "./ReprintButton";
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
  await requireSession(); // RLS below still governs actual row visibility

  const supabase = await createClient();
  const { data: job } = await supabase.from("print_jobs").select("*").eq("id", id).maybeSingle();
  if (!job) notFound();

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
        <ReprintButton jobId={job.id} />
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
      </Card>

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
