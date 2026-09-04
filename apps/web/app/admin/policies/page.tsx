import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PoliciesPanel } from "./PoliciesPanel";

export default async function PoliciesPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const { data: policies } = await supabase.from("print_policies").select("*").eq("organization_id", orgId).order("created_at");
  const policyIds = (policies ?? []).map((p) => p.id);
  const { data: rules } =
    policyIds.length > 0
      ? await supabase.from("policy_rules").select("*").in("policy_id", policyIds).order("priority")
      : { data: [] };

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Policies</h1>
      <p className="mb-6 max-w-xl text-sm text-[var(--color-muted)]">
        Precedence: any matching DENY rule wins first, then any matching REQUIRE_APPROVAL rule, then ALLOW, then the
        organization default. All conditions on a rule are AND-ed - express &quot;OR&quot; as separate rules in the same
        action tier. See docs/architecture.md sec 6.
      </p>
      <PoliciesPanel
        policies={policies ?? []}
        rules={rules ?? []}
        canManage={session.membership.role === "org_admin"}
      />
    </div>
  );
}
