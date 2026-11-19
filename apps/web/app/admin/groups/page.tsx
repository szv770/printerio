import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { peopleTabs } from "@/lib/admin/tabs";
import { fetchGroupSummaries } from "@/lib/admin/groups-list";
import { GroupsPanelLive } from "./GroupsPanelLive";

export default async function GroupsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  // Groups and how many people are in each. The people themselves are loaded when a group is opened, a page at a time.
  const groups = await fetchGroupSummaries(supabase, session.membership.organization_id);

  return (
    <div>
      <PageHeader title="Groups" description="Put people into departments or classes, so print rules and monthly limits can apply to the whole group." />
      <Tabs label="People" items={peopleTabs("groups", session.membership.role === "org_admin")} />
      <GroupsPanelLive groups={groups} canManage={session.membership.role === "org_admin"} />
    </div>
  );
}
