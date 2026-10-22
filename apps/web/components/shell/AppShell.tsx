import { createClient } from "@/lib/supabase/server";
import { resolveShell } from "@/lib/nav";
import type { SessionWithMembership } from "@/lib/auth/session";
import { AdminNav } from "./AdminNav";
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

  if (resolveShell(session.membership.role) === "member") {
    return (
      <div className="min-h-screen">
        <MemberHeader userId={session.userId} isSuperAdmin={isSuperAdmin} />
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
    // Stacks the nav above the content on a phone and only becomes a
    // sidebar+body row once there is width for one. The `[&>main]` resets
    // neutralize the member pages' own `<main mx-auto max-w-2xl px-4 py-10>`
    // wrapper so they do not double the shell's padding or float centered.
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-4 py-4 md:flex-row md:gap-8 md:py-8">
      <AdminNav
        isOrgAdmin={session.membership.role === "org_admin"}
        isSuperAdmin={isSuperAdmin}
        userId={session.userId}
        pendingApprovals={pendingApprovals ?? 0}
      />
      <div className="min-w-0 flex-1 [&>main]:mx-0 [&>main]:px-0 [&>main]:py-0">{children}</div>
    </div>
  );
}
