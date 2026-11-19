import Link from "next/link";
import { Building2 } from "lucide-react";
import { PageHeader, Card, EmptyState, Badge } from "@/components/ui";
import { routes } from "@/lib/routes";
import type { DeploymentTotals, OrganizationSummary } from "@/lib/platform/overview";
import { JoinOrganizationButton } from "./JoinOrganizationButton";

/** Presentation of the platform Overview page. Data loading stays in page.tsx; the dev preview reuses this. */
export function PlatformOverviewView({
  summaries,
  totals,
  ownMembershipByOrg,
}: {
  summaries: OrganizationSummary[];
  totals: DeploymentTotals;
  ownMembershipByOrg: Map<string, string>;
}) {
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
          <Card key={s.label} className="p-4">
            <p className="text-sm text-[var(--color-muted)]">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
          </Card>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-medium">Organizations</h2>
      {summaries.length === 0 ? (
        <EmptyState
          icon={Building2}
          message="No organizations exist yet."
          action={
            <Link href={routes.platformNewOrganization} className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-primary)]">
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
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
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
