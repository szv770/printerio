import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { currentPeriod, getApplicableQuotaLimit, getUsageSnapshot, usageForBasis } from "@/lib/quota";
import { PageHeader, Card } from "@/components/ui";
import type { QuotaBasis } from "@printos/shared";

const BASIS_LABEL: Record<QuotaBasis, string> = {
  pdf_pages: "PDF pages",
  printed_sides: "printed sides",
  physical_sheets: "physical sheets",
  color_weighted: "color-weighted sheets",
};

export default async function UsagePage() {
  const session = await requireSession();
  const supabase = await createClient();

  if (!session.membership) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <PageHeader title="Usage" />
      </main>
    );
  }

  const orgId = session.membership.organization_id;
  const { data: settings } = await supabase
    .from("organization_settings")
    .select("quota_basis")
    .eq("organization_id", orgId)
    .single();
  const basis = (settings?.quota_basis ?? "physical_sheets") as QuotaBasis;

  const { data: groupRows } = await supabase.from("group_members").select("group_id").eq("user_id", session.userId);
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
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader title="Usage" description={`This month (${currentPeriod()}), measured in ${BASIS_LABEL[basis]}.`} />
      <Card>
        <p className="text-3xl font-semibold">
          {used}
          {limit !== null && <span className="text-lg font-normal text-[var(--color-muted)]"> / {limit}</span>}
        </p>
        <p className="text-sm text-[var(--color-muted)]">{limit === null ? "No quota configured - unlimited." : `${BASIS_LABEL[basis]} used`}</p>
        {pct !== null && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full rounded-full ${pct >= 90 ? "bg-[var(--color-danger)]" : pct >= 70 ? "bg-[var(--color-warning)]" : "bg-[var(--color-success)]"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </Card>
    </main>
  );
}
