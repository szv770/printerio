import { redirect } from "next/navigation";
import { requireOrgRole } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { AdminNav } from "./AdminNav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let isOrgAdmin = false;
  let isSuperAdmin = false;
  let organizationId: string | null = null;
  let userId = "";
  try {
    const session = await requireOrgRole(["org_admin", "approver"]);
    isOrgAdmin = session.membership.role === "org_admin";
    isSuperAdmin = session.profile.platform_role === "super_admin";
    organizationId = session.membership.organization_id;
    userId = session.userId;
  } catch {
    redirect(routes.home);
  }

  // Fed to the nav's Approvals badge in both its sidebar and its mobile-bar
  // rendering - the one number an admin wants without navigating anywhere.
  const supabase = await createClient();
  const { count: pendingApprovals } = await supabase
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "pending_approval");

  return (
    // Stacks the nav above the content on a phone and only becomes a
    // sidebar+body row once there is width for one (see AdminNav's own note
    // on why the unconditional `w-48` column was the core of "the admin side
    // on phone looks nasty").
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-4 py-4 md:flex-row md:gap-8 md:py-8">
      <AdminNav
        isOrgAdmin={isOrgAdmin}
        isSuperAdmin={isSuperAdmin}
        userId={userId}
        pendingApprovals={pendingApprovals ?? 0}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
