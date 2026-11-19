/**
 * Everything the person drawer and the full detail page show about one person, loaded the same way for both. The caller has
 * already checked who the viewer is; `organizationId` comes from their session and scopes every query. The print rules (and
 * so "what can they use") are admin only under RLS, so `isOrgAdmin` decides whether that part is loaded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgRole, PolicyAction, RuleCondition } from "@printio/shared";
import type { Database } from "@/lib/database.types";
import { describeMemberAccess, type AccessRule, type MemberAccess } from "@/lib/admin/member-access";

type Db = SupabaseClient<Database>;

export const ACTIVITY_WINDOW_DAYS = 30;

export interface PersonDetail {
  userId: string;
  displayName: string | null;
  email: string;
  role: string;
  status: string;
  department: string | null;
  userCode: string | null;
  earlyTools: boolean;
  joinedAt: string;
  groups: { id: string; name: string }[];
  access: MemberAccess | null;
  jobCount: number;
  totalPages: number;
}

export async function loadPersonDetail(db: Db, input: { organizationId: string; userId: string; isOrgAdmin: boolean; now?: Date }): Promise<PersonDetail | null> {
  const { organizationId: orgId, userId } = input;
  const { data: member } = await db
    .from("organization_members")
    .select("user_id, role, status, department, user_code, early_tools, created_at, profiles(email, display_name)")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return null;

  const since = new Date((input.now ?? new Date()).getTime() - ACTIVITY_WINDOW_DAYS * 86_400_000).toISOString();
  const [{ data: recentJobs }, { data: groupRows }] = await Promise.all([
    db
      .from("print_jobs")
      .select("id, source_pdf_pages")
      .eq("organization_id", orgId)
      .eq("created_by", userId)
      // Test prints an admin sent from Admin > Printers are queue diagnostics, not this person's activity (0024_*.sql).
      .eq("is_test_print", false)
      .gte("created_at", since),
    db.from("group_members").select("group_id, groups!inner(id, name, organization_id)").eq("user_id", userId).eq("groups.organization_id", orgId),
  ]);
  const groups = (groupRows ?? []).map((r) => ({ id: r.groups.id, name: r.groups.name })).sort((a, b) => a.name.localeCompare(b.name));

  let access: MemberAccess | null = null;
  if (input.isOrgAdmin) {
    const [{ data: printers }, { data: settings }, { data: policies }] = await Promise.all([
      db.from("printers").select("id, name").eq("organization_id", orgId).order("name"),
      db.from("organization_settings").select("default_policy_action, admins_bypass_restrictions").eq("organization_id", orgId).single(),
      db.from("print_policies").select("id").eq("organization_id", orgId).eq("enabled", true),
    ]);
    const policyIds = (policies ?? []).map((p) => p.id);
    const { data: ruleRows } = policyIds.length ? await db.from("policy_rules").select("*").in("policy_id", policyIds).eq("enabled", true) : { data: [] };
    const rules: AccessRule[] = (ruleRows ?? []).map((r) => ({
      id: r.id,
      conditions: (r.conditions ?? []) as unknown as RuleCondition[],
      action: r.action as PolicyAction,
      reasonLabel: r.reason_label,
      priority: r.priority,
      enabled: r.enabled,
    }));
    access = describeMemberAccess({
      member: { userId, role: member.role as OrgRole, department: member.department, groups },
      printers: printers ?? [],
      rules,
      defaultAction: (settings?.default_policy_action ?? "require_approval") as PolicyAction,
      adminsBypassRestrictions: settings?.admins_bypass_restrictions ?? false,
    });
  }

  return {
    userId: member.user_id,
    displayName: member.profiles?.display_name ?? null,
    email: member.profiles?.email ?? "(unknown)",
    role: member.role,
    status: member.status,
    department: member.department,
    userCode: member.user_code,
    earlyTools: member.early_tools,
    joinedAt: member.created_at,
    groups,
    access,
    jobCount: recentJobs?.length ?? 0,
    totalPages: (recentJobs ?? []).reduce((sum, job) => sum + job.source_pdf_pages, 0),
  };
}
