/**
 * Pure aggregation for the /platform Overview page (app/platform/page.tsx).
 * The page itself does the actual cross-org reads (via the service-role
 * client, guarded by requirePlatformRole() - see lib/supabase/service-role.ts)
 * and hands the raw rows to buildOrganizationSummaries below, which contains
 * all of the actual logic and so is the only part worth unit-testing here.
 *
 * Deliberately fetches one flat list per table across every organization
 * (rather than N per-organization round trips) and reduces client-side -
 * see the Overview page for why that's the right tradeoff at this app's
 * scale (a handful to a few dozen organizations per deployment, never
 * thousands).
 */

/** Mirrors the "5 minutes without a heartbeat = offline" cutoff
 *  app/admin/page.tsx already uses for a single organization's agent list -
 *  kept as the same constant here rather than imported, since that page
 *  computes it inline and isn't a module this one should depend on. */
export const AGENT_ONLINE_CUTOFF_MS = 5 * 60_000;

export function isAgentOnline(lastSeenAt: string | null, nowMs: number, cutoffMs = AGENT_ONLINE_CUTOFF_MS): boolean {
  if (!lastSeenAt) return false;
  return nowMs - new Date(lastSeenAt).getTime() <= cutoffMs;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  printerCount: number;
  agentCount: number;
  agentsOnline: number;
  jobsLast30d: number;
}

export interface DeploymentTotals {
  organizations: number;
  members: number;
  printers: number;
  agents: number;
  agentsOnline: number;
  jobsLast30d: number;
}

export interface BuildOrganizationSummariesInput {
  organizations: { id: string; name: string; slug: string }[];
  /** organization_members rows across every organization (any status). */
  members: { organization_id: string }[];
  /** printers rows across every organization. */
  printers: { organization_id: string }[];
  /** agents rows across every organization. */
  agents: { organization_id: string; last_seen_at: string | null }[];
  /** print_jobs rows already filtered by the caller to created_at within the
   *  last 30 days - this function only counts, it never applies the date
   *  filter itself (that's a query concern, not aggregation logic). */
  jobsLast30d: { organization_id: string }[];
  nowMs: number;
}

function countBy<T extends { organization_id: string }>(rows: T[], organizationId: string): number {
  let n = 0;
  for (const row of rows) if (row.organization_id === organizationId) n++;
  return n;
}

export function buildOrganizationSummaries(input: BuildOrganizationSummariesInput): OrganizationSummary[] {
  return input.organizations.map((org) => {
    const orgAgents = input.agents.filter((a) => a.organization_id === org.id);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      memberCount: countBy(input.members, org.id),
      printerCount: countBy(input.printers, org.id),
      agentCount: orgAgents.length,
      agentsOnline: orgAgents.filter((a) => isAgentOnline(a.last_seen_at, input.nowMs)).length,
      jobsLast30d: countBy(input.jobsLast30d, org.id),
    };
  });
}

export function summarizeDeploymentTotals(summaries: OrganizationSummary[]): DeploymentTotals {
  return summaries.reduce(
    (acc, s) => ({
      organizations: acc.organizations + 1,
      members: acc.members + s.memberCount,
      printers: acc.printers + s.printerCount,
      agents: acc.agents + s.agentCount,
      agentsOnline: acc.agentsOnline + s.agentsOnline,
      jobsLast30d: acc.jobsLast30d + s.jobsLast30d,
    }),
    { organizations: 0, members: 0, printers: 0, agents: 0, agentsOnline: 0, jobsLast30d: 0 },
  );
}
