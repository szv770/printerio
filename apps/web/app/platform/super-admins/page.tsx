import { requirePlatformRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PageHeader } from "@/components/ui";
import { SuperAdminsPanel } from "./SuperAdminsPanel";

export default async function SuperAdminsPage() {
  const session = await requirePlatformRole();
  const supabase = createServiceRoleClient();

  const { data: superAdmins } = await supabase
    .from("profiles")
    .select("id, email, display_name, created_at")
    .eq("platform_role", "super_admin")
    .order("created_at", { ascending: true });

  return (
    <div>
      <PageHeader
        title="Super admins"
        description="Platform-level access only - a super admin has no implicit access to any organization's print jobs or files until they explicitly join it (see Overview - Join as admin), which is itself audit-logged."
      />
      <SuperAdminsPanel
        currentUserId={session.userId}
        superAdmins={(superAdmins ?? []).map((p) => ({
          userId: p.id,
          email: p.email,
          displayName: p.display_name,
        }))}
      />
    </div>
  );
}
