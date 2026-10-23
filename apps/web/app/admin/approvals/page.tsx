import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
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
  const pendingJobs = jobs ?? [];

  // Who submitted each job, and to which printer profile - an approver
  // deciding on a job needs both, and neither lives on the print_jobs row.
  // Both reads are RLS-governed (profiles' select policy admits an approver
  // for their own org's members since 0024_approver_profile_visibility.sql;
  // printer_profiles' has always admitted any member of the owning org), and
  // both are one batched `in` query rather than one per card.
  const submitterIds = [...new Set(pendingJobs.map((job) => job.created_by))];
  const profileIds = [...new Set(pendingJobs.map((job) => job.printer_profile_id).filter((id): id is string => !!id))];

  const [{ data: submitters }, { data: printerProfiles }] = await Promise.all([
    submitterIds.length > 0
      ? supabase.from("profiles").select("id, display_name, email").in("id", submitterIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string | null; email: string }[] }),
    profileIds.length > 0
      ? supabase.from("printer_profiles").select("id, label").in("id", profileIds)
      : Promise.resolve({ data: [] as { id: string; label: string }[] }),
  ]);

  const submitterNames = Object.fromEntries(
    (submitters ?? []).map((p) => [p.id, p.display_name?.trim() || p.email]),
  );
  const printerLabels = Object.fromEntries((printerProfiles ?? []).map((p) => [p.id, p.label]));

  return (
    <div>
      <PageHeader
        title="Approvals"
        description={pendingJobs.length > 0 ? "Say yes or no to each job." : "Jobs that need a yes or no show up here."}
      />
      <ApprovalQueue
        initialJobs={pendingJobs}
        organizationId={session.membership.organization_id}
        submitterNames={submitterNames}
        printerLabels={printerLabels}
      />
    </div>
  );
}
