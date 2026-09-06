import Link from "next/link";
import { Printer as PrinterIcon } from "lucide-react";
import { JOB_STATES, isTerminalState, type QuotaBasis } from "@printos/shared";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { currentPeriod, getApplicableQuotaLimit, getUsageSnapshot, usageForBasis } from "@/lib/quota";
import { routes } from "@/lib/routes";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { Card, EmptyState } from "@/components/ui";

const BASIS_LABEL: Record<QuotaBasis, string> = {
  pdf_pages: "PDF pages",
  printed_sides: "printed sides",
  physical_sheets: "physical sheets",
  color_weighted: "color-weighted sheets",
};

const RECENT_JOBS_LIMIT = 5;

// Derived from the state machine itself (not a hand-maintained list) so a
// future addition to JOB_STATES can't silently fall out of sync here:
// "in progress" = has left draft but hasn't reached a terminal state yet.
const ACTIVE_JOB_STATUSES = JOB_STATES.filter((s) => s !== "draft" && !isTerminalState(s));

/**
 * The actual landing screen for student/staff users (org_admin/approver land
 * on /admin instead - see app/page.tsx). Previously "/" was pure redirect
 * logic straight into the print form with no status view at all - a
 * returning user had no way to see "can I still print" or "did my last job
 * go through" without an extra navigation. This page answers both, then
 * gets out of the way: primary action first, status strip, recent jobs.
 */
export default async function DashboardHomePage() {
  const session = await requireSession();
  if (!session.membership) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-[var(--color-muted)]">You are not a member of any organization yet.</p>
      </main>
    );
  }

  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: settings }, { data: groupRows }, { data: recentJobs }, { count: activeJobCount }] = await Promise.all([
    supabase.from("organization_settings").select("quota_basis").eq("organization_id", orgId).single(),
    supabase.from("group_members").select("group_id").eq("user_id", session.userId),
    supabase
      .from("print_jobs")
      .select("id, job_number, original_file_name, status, created_at")
      .eq("created_by", session.userId)
      .order("created_at", { ascending: false })
      .limit(RECENT_JOBS_LIMIT),
    supabase
      .from("print_jobs")
      .select("id", { count: "exact", head: true })
      .eq("created_by", session.userId)
      .in("status", ACTIVE_JOB_STATUSES),
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
  const used = usageForBasis(usage, basis);
  const remaining = limit === null ? null : Math.max(0, limit - used);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {/* Primary action - this is what most visits are for, so it comes
       *  first and is the single most visually prominent element. */}
      <Link
        href={routes.print}
        className="mb-6 flex items-center gap-4 rounded-xl bg-[var(--color-primary)] p-6 text-[var(--color-primary-fg)] transition-opacity hover:opacity-90"
      >
        <PrinterIcon className="h-8 w-8 shrink-0" />
        <div>
          <p className="text-lg font-semibold">Print a document</p>
          <p className="text-sm opacity-90">Upload a PDF and choose your printer and options.</p>
        </div>
      </Link>

      {/* Status strip - "can I still print" / "is anything waiting on me" at
       *  a glance, no click required. */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        <Card className="p-4">
          <p className="text-sm text-[var(--color-muted)]">Quota remaining ({BASIS_LABEL[basis]})</p>
          <p className="mt-1 text-2xl font-semibold">{remaining === null ? "Unlimited" : remaining.toLocaleString()}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-[var(--color-muted)]">Jobs in progress</p>
          <p className="mt-1 text-2xl font-semibold">{activeJobCount ?? 0}</p>
        </Card>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">Recent jobs</h2>
        <Link href={routes.jobs} className="text-sm text-[var(--color-primary)]">
          View all
        </Link>
      </div>
      {!recentJobs || recentJobs.length === 0 ? (
        <EmptyState message="No print jobs yet." />
      ) : (
        <ul className="flex flex-col gap-2">
          {recentJobs.map((job) => {
            const display = jobStatusDisplay(job.status);
            return (
              <li key={job.id}>
                <Link
                  href={routes.job(job.id)}
                  className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 hover:border-[var(--color-primary)]"
                >
                  <span className="font-medium">{job.original_file_name}</span>
                  <span className="flex items-center gap-1.5 text-sm text-[var(--color-muted)]">
                    <display.Icon className="h-4 w-4" />
                    {display.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
