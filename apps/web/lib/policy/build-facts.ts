import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluatePolicy, type JobFacts, type OrgRole, type PolicyAction, type PolicyRule, type RuleCondition } from "@printos/shared";
import type { Database } from "@/lib/database.types";
import { computeQuotaUsagePct } from "@/lib/quota";

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
 */
export async function evaluateJobPolicy(supabase: Client, input: PolicyEvalInput) {
  const [{ data: groupRows }, { data: settings }, { data: policies }] = await Promise.all([
    supabase.from("group_members").select("group_id").eq("user_id", input.userId),
    supabase
      .from("organization_settings")
      .select("default_policy_action, quota_basis")
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
  const quotaBasis = (settings?.quota_basis ?? "physical_sheets") as Parameters<typeof computeQuotaUsagePct>[2];
  const policyIds = (policies ?? []).map((p) => p.id);

  let rules: PolicyRule[] = [];
  if (policyIds.length > 0) {
    const { data: ruleRows } = await supabase
      .from("policy_rules")
      .select("*")
      .in("policy_id", policyIds)
      .eq("enabled", true);
    rules = (ruleRows ?? []).map((r) => ({
      id: r.id,
      conditions: (r.conditions ?? []) as unknown as RuleCondition[],
      action: r.action as PolicyAction,
      reasonLabel: r.reason_label,
      priority: r.priority,
      enabled: r.enabled,
    }));
  }

  const quotaUsagePct = await computeQuotaUsagePct(
    supabase,
    { organizationId: input.organizationId, userId: input.userId, role: input.role, department: input.department, groupIds },
    quotaBasis,
  );

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

  return { result: evaluatePolicy(facts, rules, defaultAction), quotaBasis };
}
