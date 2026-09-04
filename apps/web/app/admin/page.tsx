import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Card } from "@/components/ui";

export default async function AdminOverviewPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [{ count: jobsToday }, { count: pendingApprovals }, { count: failedJobs }, { data: agents }, { data: printers }] =
    await Promise.all([
      supabase
        .from("print_jobs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .gte("created_at", startOfToday.toISOString()),
      supabase
        .from("print_jobs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "pending_approval"),
      supabase
        .from("print_jobs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "failed"),
      supabase.from("agents").select("id, last_seen_at").eq("organization_id", orgId),
      supabase.from("printers").select("id, status").eq("organization_id", orgId),
    ]);

  // Deliberately impure (Date.now()) - this is a Server Component computing a
  // fresh snapshot per request, not a value React needs to keep stable across
  // client re-renders.
  // eslint-disable-next-line react-hooks/purity
  const onlineCutoff = Date.now() - 5 * 60_000; // 5 min without a heartbeat = offline
  const agentsOnline = (agents ?? []).filter((a) => a.last_seen_at && new Date(a.last_seen_at).getTime() > onlineCutoff).length;

  const stats = [
    { label: "Jobs today", value: jobsToday ?? 0 },
    { label: "Pending approvals", value: pendingApprovals ?? 0 },
    { label: "Failed jobs", value: failedJobs ?? 0 },
    { label: "Agents online", value: `${agentsOnline} / ${agents?.length ?? 0}` },
    { label: "Printers", value: printers?.length ?? 0 },
  ];

  return (
    <div>
      <PageHeader title="Overview" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label} className="p-5">
            <p className="text-sm text-[var(--color-muted)]">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold">{s.value}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
