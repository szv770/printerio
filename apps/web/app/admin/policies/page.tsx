import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { rulesTabs } from "@/lib/admin/tabs";
import { PoliciesPanel } from "./PoliciesPanel";

export default async function PoliciesPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: policies }, { data: groups }] = await Promise.all([
    supabase.from("print_policies").select("*").eq("organization_id", orgId).order("created_at"),
    supabase.from("groups").select("id, name").eq("organization_id", orgId),
  ]);
  const policyIds = (policies ?? []).map((p) => p.id);
  const { data: rules } =
    policyIds.length > 0
      ? await supabase.from("policy_rules").select("*").in("policy_id", policyIds).order("priority")
      : { data: [] };

  return (
    <div>
      <PageHeader title="Print rules" description="Say when a job needs approval or is not allowed. Switch a rule off to pause it." />
      <Tabs label="Rules and limits" items={rulesTabs("rules")} />
      <PoliciesPanel
        policies={policies ?? []}
        rules={rules ?? []}
        canManage={session.membership.role === "org_admin"}
        groupNames={Object.fromEntries((groups ?? []).map((g) => [g.id, g.name]))}
      />
    </div>
  );
}
