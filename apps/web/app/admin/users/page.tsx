import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { InviteForm } from "./InviteForm";
import { MembersTable } from "./MembersTable";
import { InvitationsList } from "./InvitationsList";
import { ensureMemberUserCode } from "@/lib/jobs/ensure-user-code";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";

export default async function UsersPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role, status, department, created_at, user_code, profiles(email, display_name)")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: true });

  // Everyone who prints gets a persistent, org-unique code. Give the ones without one theirs now (service role, after
  // the requireOrgRole check above) so this page shows exactly what is stamped. A failure here is not fatal: that
  // member just shows no code until the next load or their next print.
  const memberRows = members ?? [];
  const codes = new Map<string, string>();
  for (const m of memberRows) if (m.user_code) codes.set(m.user_id, m.user_code);
  const missing = memberRows.filter((m) => !m.user_code);
  if (missing.length > 0) {
    const writer = createServiceRoleClient();
    for (const m of missing) {
      try {
        codes.set(
          m.user_id,
          await ensureMemberUserCode(writer, {
            organizationId: session.membership.organization_id,
            userId: m.user_id,
            displayName: m.profiles?.display_name ?? null,
            email: m.profiles?.email ?? null,
            stored: null,
          }),
        );
      } catch (err) {
        logger.error("could not assign a user code", { userId: m.user_id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

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
        members={memberRows.map((m) => ({
          userId: m.user_id,
          // What gets stamped (assigned above when it was missing).
          userCode: codes.get(m.user_id) ?? null,
          effectiveCode: codes.get(m.user_id) ?? "",
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
