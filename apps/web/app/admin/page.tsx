import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Card } from "@/components/ui";
import { routes } from "@/lib/routes";

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
        // "Jobs today" is a volume stat about what the organization printed,
        // so an admin's own test prints don't belong in it. "Failed jobs"
        // below deliberately does NOT filter them out: a test print that
        // failed is exactly the kind of thing this page should surface.
        .eq("is_test_print", false)
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
  const agentsOffline = (agents ?? []).filter(
    (a) => !a.last_seen_at || new Date(a.last_seen_at).getTime() <= onlineCutoff,
  ).length;
  const printersInError = (printers ?? []).filter((p) => p.status === "error" || p.status === "offline").length;

  // Problem-first: an admin scanning this page cares about what needs
  // attention, not the healthy baseline - a "3/5 online" ratio makes them do
  // the subtraction themselves. Only the two action items are linked
  // (they lead somewhere useful); "Jobs today" is a volume stat, not an
  // action, so it stays plain.
  const stats: { label: string; value: string | number; href?: string }[] = [
    { label: "Pending approvals", value: pendingApprovals ?? 0, href: routes.adminApprovals },
    { label: "Failed jobs", value: failedJobs ?? 0, href: routes.adminReports },
    { label: "Agents offline", value: agentsOffline, href: routes.adminAgents },
    { label: "Printers in error", value: printersInError, href: routes.adminPrinters },
    { label: "Jobs today", value: jobsToday ?? 0 },
  ];

  return (
    <div>
      <PageHeader title="Overview" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" data-tour="admin-overview-stats">
        {stats.map((s) => {
          const card = (
            <Card className={`p-5 ${s.href ? "transition-colors hover:bg-[var(--color-surface)]" : ""}`}>
              <p className="text-sm text-[var(--color-muted)]">{s.label}</p>
              <p className="mt-1 text-2xl font-semibold">{s.value}</p>
            </Card>
          );
          return s.href ? (
            <Link
              key={s.label}
              href={s.href}
              data-tour={s.label === "Pending approvals" ? "admin-stat-pending-approvals" : undefined}
            >
              {card}
            </Link>
          ) : (
            <div key={s.label}>{card}</div>
          );
        })}
      </div>
    </div>
  );
}
