import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { peopleTabs } from "@/lib/admin/tabs";
import { InvitesPanel } from "../users/InvitesPanel";

export default async function InvitesPage() {
  const session = await requireOrgRole(["org_admin"]);
  const supabase = await createClient();

  const { data: invitations } = await supabase
    .from("organization_invitations")
    .select("*")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: false });

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", session.membership.organization_id)
    .maybeSingle();

  return (
    <div>
      <PageHeader title="Invites" description="Invite someone with a link. Turn an invite off any time." />
      <Tabs label="People" items={peopleTabs("invites", true)} />
      <InvitesPanel
        orgName={org?.name ?? ""}
        invitations={(invitations ?? []).map((inv) => ({
          id: inv.id,
          code: inv.code,
          role: inv.role,
          usesCount: inv.uses_count,
          maxUses: inv.max_uses,
          expiresAt: inv.expires_at,
        }))}
      />
    </div>
  );
}
