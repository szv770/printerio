import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { InviteForm } from "./InviteForm";
import { MembersTable } from "./MembersTable";
import { InvitationsList } from "./InvitationsList";
import { effectiveUserCode } from "@/lib/jobs/user-code";

export default async function UsersPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role, status, department, created_at, user_code, profiles(email, display_name)")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: true });

  const { data: invitations } = await supabase
    .from("organization_invitations")
    .select("*")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: false });

  const isOrgAdmin = session.membership.role === "org_admin";

  return (
    <div>
      <PageHeader title="Users" />

      {isOrgAdmin && (
        <div className="mb-8">
          <h2 className="mb-2 text-sm font-medium">Invite someone</h2>
          <InviteForm />
        </div>
      )}

      <h2 className="mb-2 text-sm font-medium">Roster</h2>
      <MembersTable
        members={(members ?? []).map((m) => ({
          userId: m.user_id,
          // What gets stamped: the stored code, or the generated one while none is set.
          userCode: m.user_code,
          effectiveCode: effectiveUserCode({
            stored: m.user_code,
            displayName: m.profiles?.display_name ?? null,
            email: m.profiles?.email ?? null,
            userId: m.user_id,
          }).code,
          email: m.profiles?.email ?? "(unknown)",
          displayName: m.profiles?.display_name ?? null,
          role: m.role,
          status: m.status,
          department: m.department,
        }))}
        canEdit={isOrgAdmin}
      />

      {isOrgAdmin && invitations && invitations.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-medium">Open invitations</h2>
          <InvitationsList
            invitations={invitations.map((inv) => ({
              id: inv.id,
              code: inv.code,
              role: inv.role,
              usesCount: inv.uses_count,
              maxUses: inv.max_uses,
              expiresAt: inv.expires_at,
            }))}
          />
        </div>
      )}
    </div>
  );
}
