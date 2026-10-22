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
      .select("allowed_domains, magic_link_requires_allowed_domain")
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
        description="Organization-wide sign-in and security settings. See docs/architecture.md sec 19."
      />
      <SettingsPanel
        allowedDomains={org?.allowed_domains ?? []}
        magicLinkRequiresAllowedDomain={org?.magic_link_requires_allowed_domain ?? true}
        defaultBookletBindingSide={settings?.default_booklet_binding_side === "right" ? "right" : "left"}
        adminsBypassRestrictions={settings?.admins_bypass_restrictions ?? true}
        autoRetryFailedPrints={(settings as Record<string, unknown> | null)?.auto_retry_failed_prints === true}
        stamp={normalizeStampSettings(settings)}
        canManage={session.membership.role === "org_admin"}
      />
    </div>
  );
}
