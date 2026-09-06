import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";

export default async function SettingsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("allowed_domains")
    .eq("id", session.membership.organization_id)
    .single();

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Organization-wide sign-in and security settings. See docs/architecture.md sec 19."
      />
      <SettingsPanel
        allowedDomains={org?.allowed_domains ?? []}
        canManage={session.membership.role === "org_admin"}
      />
    </div>
  );
}
