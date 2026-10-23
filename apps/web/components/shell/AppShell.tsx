import { createClient } from "@/lib/supabase/server";
import { resolveShell, roleLabel } from "@/lib/nav";
import type { SessionWithMembership } from "@/lib/auth/session";
import { AdminFrame } from "./AdminFrame";
import { MemberHeader } from "./MemberHeader";

/**
 * The one app shell. Which one a user gets is decided here, on the server, by
 * their ROLE (lib/nav.ts resolveShell) - never by the URL - so an org admin or
 * approver keeps the admin sidebar on /print, /jobs, /devices, /profile and
 * /usage, and a plain member keeps the simple header.
 */
export async function AppShell({
  session,
  children,
}: {
  session: SessionWithMembership;
  children: React.ReactNode;
}) {
  const isSuperAdmin = session.profile.platform_role === "super_admin";

  const user = {
    name: session.profile.display_name,
    email: session.email,
    roleLabel: roleLabel(session.membership.role),
  };

  if (resolveShell(session.membership.role) === "member") {
    return (
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] [--sticky-bottom:calc(5.25rem+env(safe-area-inset-bottom))] sm:pb-0 sm:[--sticky-bottom:1rem]">
        <MemberHeader userId={session.userId} isSuperAdmin={isSuperAdmin} user={user} />
        {children}
      </div>
    );
  }

  // Fed to the nav's Approvals badge in both its sidebar and its mobile-bar
  // rendering - the one number an admin wants without navigating anywhere.
  const supabase = await createClient();
  const { count: pendingApprovals } = await supabase
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", session.membership.organization_id)
    .eq("status", "pending_approval");

  return (
    <AdminFrame
      isOrgAdmin={session.membership.role === "org_admin"}
      isSuperAdmin={isSuperAdmin}
      userId={session.userId}
      pendingApprovals={pendingApprovals ?? 0}
      user={user}
    >
      {children}
    </AdminFrame>
  );
}
