import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { printerTabs } from "@/lib/admin/tabs";
import { AgentsPanel } from "./AgentsPanel";

export default async function AgentsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: agents } = await supabase
    .from("agents")
    .select("*")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: false });

  const isOrgAdmin = session.membership.role === "org_admin";

  return (
    <div>
      <PageHeader title="Print servers" description="The Windows computers that send approved jobs to your printers." />
      <Tabs label="Printers and devices" items={printerTabs("agents", isOrgAdmin)} />
      <AgentsPanel agents={agents ?? []} canManage={isOrgAdmin} />
    </div>
  );
}
