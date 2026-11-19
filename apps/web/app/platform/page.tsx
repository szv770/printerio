import { requirePlatformRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PageHeader } from "@/components/ui";
import { buildOrganizationSummaries, summarizeDeploymentTotals } from "@/lib/platform/overview";
import { PlatformOverviewView } from "./OverviewView";

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

  return <PlatformOverviewView summaries={summaries} totals={totals} ownMembershipByOrg={ownMembershipByOrg} />;
}
