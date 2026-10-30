import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { peopleTabs } from "@/lib/admin/tabs";
import { MembersTable } from "./MembersTable";
import { ensureMemberUserCode } from "@/lib/jobs/ensure-user-code";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { findUnmatchedSignups, type UnmatchedSignup } from "@/lib/admin/unmatched-signups";
import { UnmatchedSignups } from "./UnmatchedSignups";

export default async function UsersPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role, status, department, created_at, user_code, profiles(email, display_name)")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: true })
    .limit(1000);

  // Everyone who prints gets a persistent, org-unique code. Give the ones without one theirs now (service role, after
  // the requireOrgRole check above) so this page shows exactly what is stamped. A failure here is not fatal: that
  // member just shows no code until the next load or their next print.
  const memberRows = members ?? [];
  const codes = new Map<string, string>();
  for (const m of memberRows) if (m.user_code) codes.set(m.user_id, m.user_code);
  const missing = memberRows.filter((m) => !m.user_code);
  if (missing.length > 0) {
    const writer = createServiceRoleClient();
    await Promise.all(
      missing.map(async (m) => {
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
      }),
    );
  }

  const isOrgAdmin = session.membership.role === "org_admin";

  // Admin-only: accounts with a sign-in but no membership anywhere (service role, after the org_admin check).
  let signups: UnmatchedSignup[] = [];
  if (isOrgAdmin) {
    try {
      signups = await findUnmatchedSignups(createServiceRoleClient());
    } catch (err) {
      logger.error("could not list sign-ups without access", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div>
      <PageHeader title="Users" description="Everyone who can print here. Change a role, department or print code, then save." />
      <Tabs label="People" items={peopleTabs("users", isOrgAdmin)} />
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
      {isOrgAdmin && <UnmatchedSignups signups={signups} />}
    </div>
  );
}
