import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { currentPeriod, getApplicableQuotaLimit, getUsageSnapshot, usageForBasis } from "@/lib/quota";
import { PageHeader } from "@/components/ui";
import { UsageView } from "./UsageView";
import type { QuotaBasis } from "@printio/shared";

export default async function UsagePage() {
  const session = await requireSessionOrRedirect();
  const supabase = await createClient();

  if (!session.membership) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
        <PageHeader title="My usage" />
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
  return <UsageView used={used} limit={limit} basis={basis} period={currentPeriod()} />;
}
