import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { peopleTabs } from "@/lib/admin/tabs";
import { GroupsPanel } from "./GroupsPanel";

export default async function GroupsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: groups }, { data: members }] = await Promise.all([
    supabase.from("groups").select("id, name, kind").eq("organization_id", orgId).order("name").limit(500),
    supabase
      .from("organization_members")
      .select("user_id, profiles(email, display_name)")
      .eq("organization_id", orgId)
      .limit(2000),
  ]);

  const groupIds = (groups ?? []).map((g) => g.id);
  const { data: groupMembers } =
    groupIds.length > 0
      ? await supabase.from("group_members").select("group_id, user_id").in("group_id", groupIds).limit(5000)
      : { data: [] };

  return (
    <div>
      <PageHeader title="Groups" description="Put people into departments or classes, so print rules and monthly limits can apply to the whole group." />
      <Tabs label="People" items={peopleTabs("groups", session.membership.role === "org_admin")} />
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
