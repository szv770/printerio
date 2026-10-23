import { JOB_STATES, isTerminalState, type QuotaBasis } from "@printio/shared";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { currentPeriod, getApplicableQuotaLimit, getUsageSnapshot, usageForBasis } from "@/lib/quota";
import { routes } from "@/lib/routes";
import { ButtonLink } from "@/components/ui";
import { firstName, jobMetaLine, quotaCard, statusCards, teacherEmptyText } from "@/lib/home/teacher-home";
import { AutoRefresh } from "@/components/home/AutoRefresh";
import { BigPrintCard } from "@/components/home/BigPrintCard";
import { StatusCards } from "@/components/home/StatusCards";
import { RecentJobs } from "@/components/home/RecentJobs";

const RECENT_JOBS_LIMIT = 5;
const COUNT_CAP = 100;

// Derived from the state machine (not a hand-kept list): "printing now" = left
// the approval stage but not yet finished.
const PRINTING_STATUSES = JOB_STATES.filter(
  (s) => !isTerminalState(s) && !["draft", "held", "pending_approval", "approved"].includes(s),
);
const COUNTED_STATUSES = [...PRINTING_STATUSES, "approved", "pending_approval"];

/**
 * The landing screen for staff/students (admins land on /admin). Mobile
 * first: greeting, one big Print button, a small status strip, and the last
 * few jobs. Reads only this person's own rows with the session client.
 */
export default async function DashboardHomePage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-[var(--color-muted)]">You are not a member of any organization yet.</p>
      </main>
    );
  }

  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  const now = new Date();

  const [{ data: settings }, { data: groupRows }, { data: recentJobs }, { data: openJobs }] = await Promise.all([
    supabase.from("organization_settings").select("quota_basis").eq("organization_id", orgId).single(),
    supabase.from("group_members").select("group_id").eq("user_id", session.userId),
    supabase
      .from("print_jobs")
      .select("id, original_file_name, status, created_at, source_pdf_pages, copies")
      .eq("created_by", session.userId)
      .order("created_at", { ascending: false })
      .limit(RECENT_JOBS_LIMIT),
    // One small query for both counts (printing now / waiting for approval).
    supabase
      .from("print_jobs")
      .select("status")
      .eq("created_by", session.userId)
      .in("status", COUNTED_STATUSES)
      .limit(COUNT_CAP),
  ]);

  const basis = (settings?.quota_basis ?? "physical_sheets") as QuotaBasis;
  const ctx = {
    organizationId: orgId,
    userId: session.userId,
    role: session.membership.role,
    department: session.membership.department,
    groupIds: (groupRows ?? []).map((g) => g.group_id),
  };
  const [limit, usage] = await Promise.all([
    getApplicableQuotaLimit(supabase, ctx),
    getUsageSnapshot(supabase, orgId, session.userId, currentPeriod()),
  ]);

  const open = openJobs ?? [];
  const cards = statusCards({
    quota: quotaCard({ limit, used: usageForBasis(usage, basis), basis }),
    printing: open.filter((j) => PRINTING_STATUSES.includes(j.status as never)).length,
    waiting: open.filter((j) => j.status === "pending_approval").length,
  });

  const rows = (recentJobs ?? []).map((j) => ({
    id: j.id,
    href: routes.job(j.id),
    name: j.original_file_name,
    status: j.status,
    meta: jobMetaLine({ pages: j.source_pdf_pages, copies: j.copies, createdAt: j.created_at }, now),
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <AutoRefresh />
      <h1 className="mb-4 text-2xl font-bold tracking-[-0.03em]">Hi {firstName(session.profile.display_name, session.email)}</h1>
      <div className="mb-5">
        <BigPrintCard hint="Upload a PDF and choose your options." tourId="home-print-cta" />
      </div>
      <StatusCards cards={cards} />
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold tracking-[-0.01em]">Your last jobs</h2>
        {rows.length > 0 && (
          <ButtonLink href={routes.jobs} variant="ghost" size="sm">
            View all
          </ButtonLink>
        )}
      </div>
      <RecentJobs jobs={rows} emptyText={teacherEmptyText()} />
    </main>
  );
}
