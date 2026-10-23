import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { rulesTabs } from "@/lib/admin/tabs";
import { unitWord } from "@/lib/admin/rules";
import { QuotasPanel } from "./QuotasPanel";

export default async function QuotasPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: quotas }, { data: groups }, { data: members }, { data: settings }] = await Promise.all([
    supabase.from("quotas").select("*").eq("organization_id", orgId).order("scope_type"),
    supabase.from("groups").select("id, name").eq("organization_id", orgId).order("name"),
    supabase
      .from("organization_members")
      .select("user_id, profiles(email, display_name)")
      .eq("organization_id", orgId),
    supabase.from("organization_settings").select("quota_basis").eq("organization_id", orgId).maybeSingle(),
  ]);

  const quotaBasis = settings?.quota_basis ?? "physical_sheets";

  return (
    <div>
      <PageHeader
        title="Monthly limits"
        description={`How many ${unitWord(quotaBasis)} someone can print each month. If a person fits more than one limit, the lowest one applies.`}
      />
      <Tabs label="Rules and limits" items={rulesTabs("quotas")} />
      <QuotasPanel
        quotas={quotas ?? []}
        groups={groups ?? []}
        roster={(members ?? []).map((m) => ({
          userId: m.user_id,
          label: m.profiles?.display_name ?? m.profiles?.email ?? m.user_id,
        }))}
        canManage={session.membership.role === "org_admin"}
        quotaBasis={quotaBasis}
      />
    </div>
  );
}
