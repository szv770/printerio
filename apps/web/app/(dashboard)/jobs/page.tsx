import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import { JobsList } from "./JobsList";

export default async function JobsPage() {
  const session = await requireSession();
  if (!session.membership) redirect(routes.noAccess);

  const supabase = await createClient();
  const { data: jobs } = await supabase
    .from("print_jobs")
    // policy_action/policy_reasons/error_message are what let a row say WHY
    // it stopped without the user opening it (JobsList's attentionLine), and
    // updated_at is what orders "when did this last move".
    .select(
      "id, job_number, original_file_name, status, source_pdf_pages, color_mode, duplex, copies, policy_action, policy_reasons, error_message, created_at, updated_at",
    )
    .eq("created_by", session.userId)
    .order("created_at", { ascending: false })
    .limit(50);
  const jobRows = jobs ?? [];

  /**
   * A stopped job's status alone doesn't say WHERE it stopped - `failed` can
   * mean "the agent never got the file" or "the spooler rejected it", and
   * `expired` can mean "nobody approved it" or "no printer collected it".
   * Its own event trail does say, so the list's stage bars are fed the same
   * events the detail page's stepper uses rather than guessing. One indexed
   * query (print_job_events_job_idx) for the whole page, not one per row.
   */
  const eventTypesByJob: Record<string, string[]> = {};
  if (jobRows.length > 0) {
    const { data: events } = await supabase
      .from("print_job_events")
      .select("job_id, event_type")
      .in(
        "job_id",
        jobRows.map((j) => j.id),
      )
      .order("created_at", { ascending: true });
    for (const event of events ?? []) {
      (eventTypesByJob[event.job_id] ??= []).push(event.event_type);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader
        title="My jobs"
        action={
          <Link href={routes.print} className="text-sm font-medium text-[var(--color-primary)]">
            + New print job
          </Link>
        }
      />
      <JobsList initialJobs={jobRows} eventTypesByJob={eventTypesByJob} userId={session.userId} />
    </main>
  );
}
