import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { ApprovalQueue } from "./ApprovalQueue";

export default async function ApprovalsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: jobs } = await supabase
    .from("print_jobs")
    .select("*")
    .eq("organization_id", session.membership.organization_id)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Print approvals</h1>
      <ApprovalQueue initialJobs={jobs ?? []} organizationId={session.membership.organization_id} />
    </div>
  );
}
