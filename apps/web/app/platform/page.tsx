import Link from "next/link";
import { Building2 } from "lucide-react";
import { requirePlatformRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PageHeader, Card, EmptyState, Badge } from "@/components/ui";
import { routes } from "@/lib/routes";
import { buildOrganizationSummaries, summarizeDeploymentTotals } from "@/lib/platform/overview";
import { JoinOrganizationButton } from "./JoinOrganizationButton";

export default async function PlatformOverviewPage() {
  const session = await requirePlatformRole();
  const supabase = createServiceRoleClient();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // One flat read per table across every organization, reduced client-side in
  // lib/platform/overview.ts - see that module's header comment for why that
  // beats N per-organization round trips at this app's scale. All of these
  // deliberately go through the service-role client: RLS scopes the ordinary
  // client to the caller's own organizations (docs/architecture.md sec 3),
  // and this page is the one legitimate place that needs every organization
  // at once (requirePlatformRole() above is what makes that safe).
  const [
    { data: organizations, error: orgsError },
    { data: members },
    { data: printers },
    { data: agents },
    { data: jobsLast30d },
    { data: ownMemberships },
  ] = await Promise.all([
    supabase.from("organizations").select("id, name, slug").order("name", { ascending: true }).limit(500),
    supabase.from("organization_members").select("organization_id").limit(10000),
    supabase.from("printers").select("organization_id").limit(5000),
    supabase.from("agents").select("organization_id, last_seen_at").limit(5000),
    // Admin test prints are excluded from this per-organization job count for
    // the same reason they're excluded from Reports: they measure whether a
    // queue works, not what an organization printed (0024_*.sql).
    supabase
      .from("print_jobs")
      .select("organization_id")
      .eq("is_test_print", false)
      .gte("created_at", thirtyDaysAgo.toISOString())
      .limit(20000),
    supabase.from("organization_members").select("organization_id, role").eq("user_id", session.userId).limit(500),
  ]);

  if (orgsError) {
    return (
      <div>
        <PageHeader title="Overview" />
        <p className="text-sm text-[var(--color-danger)]">Couldn&apos;t load organizations: {orgsError.message}</p>
      </div>
    );
  }

  // Deliberately impure (Date.now()) - this is a Server Component computing a
  // fresh snapshot per request, not a value React needs to keep stable across
  // client re-renders (see the identical pattern/comment in app/admin/page.tsx).
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const summaries = buildOrganizationSummaries({
    organizations: organizations ?? [],
    members: members ?? [],
    printers: printers ?? [],
    agents: agents ?? [],
    jobsLast30d: jobsLast30d ?? [],
    nowMs,
  });
  const totals = summarizeDeploymentTotals(summaries);

  const ownMembershipByOrg = new Map((ownMemberships ?? []).map((m) => [m.organization_id, m.role]));

  const totalStats: { label: string; value: number }[] = [
    { label: "Organizations", value: totals.organizations },
    { label: "Members", value: totals.members },
    { label: "Printers", value: totals.printers },
    { label: "Agents online", value: totals.agentsOnline },
    { label: "Agents total", value: totals.agents },
    { label: "Jobs (30d)", value: totals.jobsLast30d },
  ];

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Every organization in this deployment. Super-admin access here is platform-level - it grants no implicit access to any organization's print jobs or files."
      />

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {totalStats.map((s) => (
          <Card key={s.label} className="p-5">
            <p className="text-sm text-[var(--color-muted)]">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold">{s.value}</p>
          </Card>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-medium">Organizations</h2>
      {summaries.length === 0 ? (
        <EmptyState
          icon={Building2}
          message="No organizations exist yet."
          action={
            <Link href={routes.platformNewOrganization} className="text-sm font-medium text-[var(--color-primary)]">
              Create the first organization
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {summaries.map((org) => {
            const ownRole = ownMembershipByOrg.get(org.id);
            return (
              <Card key={org.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{org.name}</p>
                    <p className="text-xs text-[var(--color-muted)]">/{org.slug}</p>
                  </div>
                  {ownRole ? (
                    <Badge tone="success">You: {ownRole}</Badge>
                  ) : (
                    <JoinOrganizationButton organizationId={org.id} organizationName={org.name} />
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                  <Stat label="Members" value={org.memberCount} />
                  <Stat label="Printers" value={org.printerCount} />
                  <Stat label="Agents" value={`${org.agentsOnline}/${org.agentCount} online`} />
                  <Stat label="Jobs (30d)" value={org.jobsLast30d} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
