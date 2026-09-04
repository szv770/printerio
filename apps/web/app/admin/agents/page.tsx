import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { AgentsPanel } from "./AgentsPanel";

export default async function AgentsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: agents } = await supabase
    .from("agents")
    .select("*")
    .eq("organization_id", session.membership.organization_id)
    .order("created_at", { ascending: false });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Agents</h1>
      <AgentsPanel agents={agents ?? []} canManage={session.membership.role === "org_admin"} />
    </div>
  );
}
