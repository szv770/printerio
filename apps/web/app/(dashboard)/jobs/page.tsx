import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { ButtonLink, PageHeader } from "@/components/ui";
import { Plus } from "lucide-react";
import { JobsList } from "./JobsList";
import Link from "next/link";
import { cardsSince, preparingCards } from "@/lib/prepare/my-jobs";

export default async function JobsPage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) redirect(routes.noAccess);

  const supabase = await createClient();
  const { data: jobs } = await supabase
    .from("print_jobs")
    // policy_action/policy_reasons/error_message/held_reason are what let a row say WHY
    // it stopped without the user opening it (JobsList's attentionLine), and
    // updated_at is what orders "when did this last move".
    .select(
      "id, job_number, original_file_name, status, source_pdf_pages, color_mode, duplex, copies, policy_action, policy_reasons, error_message, held_reason, is_test_print, files_purged_at, created_at, updated_at",
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

  // Files still being prepared by the print server have no job yet. A failed read just shows nothing: this page works with every print server off.
  const { data: prepareRows } = await supabase
    .from("server_jobs")
    .select("id, status, params, result")
    .eq("kind", "prepare_pdf")
    .eq("requested_by", session.userId)
    .in("status", ["queued", "claimed", "done", "failed"])
    .gte("created_at", cardsSince())
    .order("created_at", { ascending: false })
    .limit(10);
  const cards = preparingCards(prepareRows ?? []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader
        title="My jobs"
        action={
          <ButtonLink href={routes.print} size="sm">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New print job
          </ButtonLink>
        }
      />
      {cards.length > 0 ? (
        <ul className="mb-4 space-y-2" aria-label="Files being prepared">
          {cards.map((c) => (
            <li key={c.id}>
              <Link href={routes.preparing(c.id)} className="block rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
                <span className="font-medium">{c.fileName}</span>
                <span className="ml-2 text-[var(--color-muted)]">
                  {c.state === "preparing" ? "Preparing..." : c.state === "needs_booklet_confirm" ? "Needs your answer" : "Could not be prepared"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <JobsList initialJobs={jobRows} eventTypesByJob={eventTypesByJob} userId={session.userId} />
    </main>
  );
}
