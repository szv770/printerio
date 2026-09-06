import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { GroupsPanel } from "./GroupsPanel";

export default async function GroupsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: groups }, { data: members }] = await Promise.all([
    supabase.from("groups").select("*").eq("organization_id", orgId).order("name"),
    supabase
      .from("organization_members")
      .select("user_id, profiles(email, display_name)")
      .eq("organization_id", orgId),
  ]);

  const groupIds = (groups ?? []).map((g) => g.id);
  const { data: groupMembers } =
    groupIds.length > 0
      ? await supabase.from("group_members").select("group_id, user_id").in("group_id", groupIds)
      : { data: [] };

  return (
    <div>
      <PageHeader
        title="Groups"
        description="Departments/classes/custom cohorts print policies and quotas can scope on (scope_type: 'group'). See docs/architecture.md."
      />
      <GroupsPanel
        groups={groups ?? []}
        groupMembers={groupMembers ?? []}
        roster={(members ?? []).map((m) => ({
          userId: m.user_id,
          label: m.profiles?.display_name ?? m.profiles?.email ?? m.user_id,
        }))}
        canManage={session.membership.role === "org_admin"}
      />
    </div>
  );
}
