import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";
import { normalizeStampSettings } from "@/lib/jobs/user-code";

export default async function SettingsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const [{ data: org }, { data: settings }] = await Promise.all([
    supabase
      .from("organizations")
      // select("*"): join_mode / domain_join_role (migration 0039) may not exist yet; naming them would fail the whole read.
      .select("*")
      .eq("id", session.membership.organization_id)
      .single(),
    supabase
      .from("organization_settings")
      // select("*"): auto_retry_failed_prints (migration 0035) may not exist yet; naming it would fail the whole read.
      .select("*")
      .eq("organization_id", session.membership.organization_id)
      .single(),
  ]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Who can join, how printing behaves by default, and the print stamp. Open a section to change it, then save."
      />
      <SettingsPanel
        allowedDomains={org?.allowed_domains ?? []}
        joinMode={org?.join_mode === "invite_or_domain" ? "invite_or_domain" : "invite_only"}
        domainJoinRole={org?.domain_join_role === "staff" ? "staff" : "student"}
        defaultBookletBindingSide={settings?.default_booklet_binding_side === "right" ? "right" : "left"}
        adminsBypassRestrictions={settings?.admins_bypass_restrictions ?? true}
        autoRetryFailedPrints={(settings as Record<string, unknown> | null)?.auto_retry_failed_prints === true}
        stamp={normalizeStampSettings(settings)}
        canManage={session.membership.role === "org_admin"}
      />
    </div>
  );
}
