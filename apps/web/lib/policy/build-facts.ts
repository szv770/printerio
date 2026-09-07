import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluatePolicy, type JobFacts, type OrgRole, type PolicyAction, type PolicyRule, type RuleCondition } from "@printio/shared";
import type { Database } from "@/lib/database.types";
import { computeQuotaUsage } from "@/lib/quota";

type Client = SupabaseClient<Database>;

export interface PolicyEvalInput {
  organizationId: string;
  userId: string;
  role: OrgRole;
  department: string | null;
  printerId: string | null;
  pageCount: number;
  copies: number;
  colorMode: "bw" | "color";
  duplex: boolean;
  paperSize: string;
  finishingStaple: boolean;
  finishingBooklet: boolean;
  finishingPunch: boolean;
  estimatedPhysicalSheets: number;
  estimatedCostCents: number | null;
}

/**
 * Assembles JobFacts from live DB state (never trusting client-supplied
 * facts beyond the print-option selections the caller already validated) and
 * runs the pure policy engine. See docs/architecture.md sec 6 and
 * packages/shared/src/policy-engine.ts.
 *
 * Also returns the `groupIds` and `quotaLimit` it had to resolve anyway, so
 * the submit path (print/actions.ts) can reserve quota without re-issuing the
 * identical `group_members` and `quotas` queries a second time - that
 * duplication used to cost two extra sequential round trips on every single
 * job submission.
 */
export async function evaluateJobPolicy(supabase: Client, input: PolicyEvalInput) {
  const [{ data: groupRows }, { data: settings }, { data: policies }] = await Promise.all([
    supabase.from("group_members").select("group_id").eq("user_id", input.userId),
    supabase
      .from("organization_settings")
      .select("default_policy_action, quota_basis, admins_bypass_restrictions")
      .eq("organization_id", input.organizationId)
      .single(),
    supabase
      .from("print_policies")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("enabled", true),
  ]);

  const groupIds = (groupRows ?? []).map((r) => r.group_id);
  const defaultAction = (settings?.default_policy_action ?? "require_approval") as PolicyAction;
  const quotaBasis = (settings?.quota_basis ?? "physical_sheets") as Parameters<typeof computeQuotaUsage>[2];
  const policyIds = (policies ?? []).map((p) => p.id);

  // The rule fetch and the quota lookup depend only on what the batch above
  // already resolved (policyIds / groupIds respectively) and not on each
  // other, so they overlap rather than serialize.
  const [rules, quota] = await Promise.all([
    fetchPolicyRules(supabase, policyIds),
    computeQuotaUsage(
      supabase,
      { organizationId: input.organizationId, userId: input.userId, role: input.role, department: input.department, groupIds },
      quotaBasis,
    ),
  ]);
  const quotaUsagePct = quota.usagePct;

  const now = new Date();
  const facts: JobFacts = {
    role: input.role,
    userId: input.userId,
    groupIds,
    department: input.department,
    printerId: input.printerId,
    pageCount: input.pageCount,
    copies: input.copies,
    colorMode: input.colorMode,
    duplex: input.duplex,
    paperSize: input.paperSize,
    finishingStaple: input.finishingStaple,
    finishingBooklet: input.finishingBooklet,
    finishingPunch: input.finishingPunch,
    estimatedPhysicalSheets: input.estimatedPhysicalSheets,
    estimatedCostCents: input.estimatedCostCents,
    timeOfDayMinutes: now.getHours() * 60 + now.getMinutes(),
    dayOfWeek: now.getDay(),
    monthlyQuotaUsagePct: quotaUsagePct,
  };

  return {
    result: evaluatePolicy(facts, rules, defaultAction),
    quotaBasis,
    groupIds,
    quotaLimit: quota.limit,
    // Default true (organization_settings row always exists per-org, but a
    // defensive fallback to the safer "no bypass" reading if it were ever
    // somehow missing) - see lib/policy/admin-bypass.ts.
    adminsBypassRestrictions: settings?.admins_bypass_restrictions ?? false,
  };
}

async function fetchPolicyRules(supabase: Client, policyIds: string[]): Promise<PolicyRule[]> {
  if (policyIds.length === 0) return [];
  const { data: ruleRows } = await supabase
    .from("policy_rules")
    .select("*")
    .in("policy_id", policyIds)
    .eq("enabled", true);
  return (ruleRows ?? []).map((r) => ({
    id: r.id,
    conditions: (r.conditions ?? []) as unknown as RuleCondition[],
    action: r.action as PolicyAction,
    reasonLabel: r.reason_label,
    priority: r.priority,
    enabled: r.enabled,
  }));
}
