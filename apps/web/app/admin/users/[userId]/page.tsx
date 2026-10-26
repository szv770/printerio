import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { Card, PageHeader } from "@/components/ui";
import { MemberDetailControls } from "./MemberDetailControls";
import { MemberAccessCard } from "./MemberAccessCard";
import { EarlyToolsCard } from "./EarlyToolsCard";
import { describeMemberAccess, type AccessRule } from "@/lib/admin/member-access";
import type { OrgRole, PolicyAction, RuleCondition } from "@printio/shared";

const ACTIVITY_WINDOW_DAYS = 30;

/** A real per-member view - MembersTable's roster row crams role, department,
 *  status, name, and email into one dense line with no room for anything
 *  else (when they joined, what they've actually printed). This is that
 *  detail: same edit controls as the roster, just laid out with room, plus
 *  a real activity summary instead of nothing at all. */
export default async function MemberDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();

  const { data: member } = await supabase
    .from("organization_members")
    .select("user_id, role, status, department, early_tools, created_at, profiles(email, display_name)")
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) notFound();

  const isOrgAdmin = session.membership.role === "org_admin";

  // Scoped exactly like every other query on this feature: organization_id
  // from the session, never a client-supplied value, so this never reaches
  // outside the admin's own organization - RLS would refuse it anyway, but
  // the query itself doesn't rely on that as its only guard.
  //
  // Deliberately impure (Date.now()) - this is a Server Component computing a
  // fresh snapshot per request, same rationale as admin/page.tsx's
  // onlineCutoff and admin/reports/page.tsx's `since`.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: recentJobs } = await supabase
    .from("print_jobs")
    .select("id, source_pdf_pages")
    .eq("organization_id", session.membership.organization_id)
    .eq("created_by", userId)
    // This card is "what has this person printed", so the test prints an
    // org_admin sent from Admin → Printers are excluded - they are queue
    // diagnostics, not this person's print activity (0024_*.sql).
    .eq("is_test_print", false)
    .gte("created_at", since);

  const jobCount = recentJobs?.length ?? 0;
  const totalPages = (recentJobs ?? []).reduce((sum, job) => sum + job.source_pdf_pages, 0);

  // What they can use. Groups are visible to admins and approvers; the print rules (and so the per-printer
  // answer) are admin-only under RLS, so approvers see the groups only.
  const orgId = session.membership.organization_id;
  const { data: groupRows } = await supabase.from("group_members").select("group_id, groups!inner(id, name, organization_id)").eq("user_id", userId).eq("groups.organization_id", orgId);
  const memberGroups = (groupRows ?? []).map((r) => ({ id: r.groups.id, name: r.groups.name })).sort((a, b) => a.name.localeCompare(b.name));
  let access: ReturnType<typeof describeMemberAccess> | null = null;
  if (isOrgAdmin) {
    const [{ data: printers }, { data: settings }, { data: policies }] = await Promise.all([
      supabase.from("printers").select("id, name").eq("organization_id", orgId).order("name"),
      supabase.from("organization_settings").select("default_policy_action, admins_bypass_restrictions").eq("organization_id", orgId).single(),
      supabase.from("print_policies").select("id").eq("organization_id", orgId).eq("enabled", true),
    ]);
    const policyIds = (policies ?? []).map((p) => p.id);
    const { data: ruleRows } = policyIds.length
      ? await supabase.from("policy_rules").select("*").in("policy_id", policyIds).eq("enabled", true)
      : { data: [] };
    const rules: AccessRule[] = (ruleRows ?? []).map((r) => ({
      id: r.id,
      conditions: (r.conditions ?? []) as unknown as RuleCondition[],
      action: r.action as PolicyAction,
      reasonLabel: r.reason_label,
      priority: r.priority,
      enabled: r.enabled,
    }));
    access = describeMemberAccess({
      member: { userId, role: member.role as OrgRole, department: member.department, groups: memberGroups },
      printers: printers ?? [],
      rules,
      defaultAction: (settings?.default_policy_action ?? "require_approval") as PolicyAction,
      adminsBypassRestrictions: settings?.admins_bypass_restrictions ?? false,
    });
  }

  const displayName = member.profiles?.display_name ?? null;
  const email = member.profiles?.email ?? "(unknown)";

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={routes.adminUsers}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to users
      </Link>

      <PageHeader title={displayName ?? email} description={displayName ? email : undefined} />

      <Card className="mb-4">
        <MemberDetailControls
          member={{
            userId: member.user_id,
            role: member.role,
            status: member.status,
            department: member.department,
          }}
          canEdit={isOrgAdmin}
        />
      </Card>

      <MemberAccessCard groups={memberGroups.map((g) => g.name)} access={access} firstName={(displayName ?? email).split(/[\s@]/)[0] ?? "This person"} />

      <EarlyToolsCard
        userId={member.user_id}
        isAdmin={member.role === "org_admin"}
        enabled={member.early_tools}
        canEdit={isOrgAdmin}
        firstName={(displayName ?? email).split(/[\s@]/)[0] ?? "this person"}
      />

      <Card className="mb-4 text-sm">
        <p className="text-[var(--color-muted)]">Joined</p>
        <p className="font-medium">{new Date(member.created_at).toLocaleDateString()}</p>
      </Card>

      <Card className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[var(--color-muted)]">Print jobs (last {ACTIVITY_WINDOW_DAYS} days)</p>
          <p className="text-lg font-semibold">{jobCount}</p>
        </div>
        <div>
          <p className="text-[var(--color-muted)]">Pages (last {ACTIVITY_WINDOW_DAYS} days)</p>
          <p className="text-lg font-semibold">{totalPages}</p>
        </div>
      </Card>
    </div>
  );
}
