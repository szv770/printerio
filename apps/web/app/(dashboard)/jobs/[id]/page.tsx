import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { Card } from "@/components/ui";
import { JobStatusLive } from "./JobStatusLive";

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

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">{job.original_file_name}</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">{job.job_number}</p>

      <JobStatusLive jobId={job.id} initialStatus={job.status} initialErrorMessage={job.error_message} />

      {/* The reason a job was denied/needs approval is the thing a user most
       *  wants explained - shown right under status, before the generic
       *  page/copy/color details below (which the user already knows, since
       *  they're the one who picked them). Auto-approved jobs have no
       *  reasons to show and just skip straight to the details grid. */}
      {job.policy_reasons.length > 0 && (
        <Card className="mt-6 text-sm">
          <p className="mb-1 font-medium">
            {job.policy_action === "deny" ? "Why this was denied" : job.policy_action === "require_approval" ? "Why this needs approval" : "Auto-approved"}
          </p>
          <ul className="list-inside list-disc text-[var(--color-muted)]">
            {job.policy_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card className={`grid grid-cols-2 gap-4 text-sm ${job.policy_reasons.length > 0 ? "mt-4" : "mt-6"}`}>
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

      {events && events.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-medium">History</p>
          <ul className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            {events.map((e) => (
              <li key={e.id}>
                {new Date(e.created_at).toLocaleString()} — {e.event_type}
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
