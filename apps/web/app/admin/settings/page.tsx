import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";

export default async function SettingsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const [{ data: org }, { data: settings }] = await Promise.all([
    supabase
      .from("organizations")
      .select("allowed_domains, magic_link_requires_allowed_domain")
      .eq("id", session.membership.organization_id)
      .single(),
    supabase
      .from("organization_settings")
      .select("default_booklet_binding_side")
      .eq("organization_id", session.membership.organization_id)
      .single(),
  ]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Organization-wide sign-in and security settings. See docs/architecture.md sec 19."
      />
      <SettingsPanel
        allowedDomains={org?.allowed_domains ?? []}
        magicLinkRequiresAllowedDomain={org?.magic_link_requires_allowed_domain ?? true}
        defaultBookletBindingSide={settings?.default_booklet_binding_side === "right" ? "right" : "left"}
        canManage={session.membership.role === "org_admin"}
      />
    </div>
  );
}
