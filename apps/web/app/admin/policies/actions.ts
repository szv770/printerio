"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import type { RuleCondition } from "@printos/shared";
import type { Json } from "@/lib/database.types";
import { routes } from "@/lib/routes";

export interface PolicyActionState {
  error?: string;
}
const initial: PolicyActionState = {};
export { initial as initialPolicyActionState };

export async function createPolicyAction(_prev: PolicyActionState, formData: FormData): Promise<PolicyActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  const supabase = await createClient();
  const { error } = await supabase.from("print_policies").insert({ organization_id: session.membership.organization_id, name });
  if (error) return { error: error.message };

  revalidatePath(routes.adminPolicies);
  return {};
}

/**
 * V1 rule editor: conditions are entered as raw JSON
 * (`[{"field":"page_count","operator":"gt","value":20}]`) rather than a
 * visual builder - see docs/architecture.md sec 6 for the condition/operator
 * vocabulary. A drag-and-drop rule builder is reserved as a natural V1.5 UI
 * improvement on top of this same data model; the engine itself
 * (packages/shared/src/policy-engine.ts) does not change either way.
 */
export async function createPolicyRuleAction(_prev: PolicyActionState, formData: FormData): Promise<PolicyActionState> {
  await requireOrgRole(["org_admin"]);
  const policyId = String(formData.get("policyId") ?? "");
  const action = String(formData.get("action") ?? "");
  const reasonLabel = String(formData.get("reasonLabel") ?? "").trim();
  const priority = parseInt(String(formData.get("priority") ?? "100"), 10) || 100;
  const conditionsRaw = String(formData.get("conditions") ?? "[]");

  if (!["allow", "require_approval", "deny"].includes(action)) return { error: "Invalid action." };
  if (!reasonLabel) return { error: "Reason label is required." };

  let conditions: RuleCondition[];
  try {
    conditions = JSON.parse(conditionsRaw);
    if (!Array.isArray(conditions)) throw new Error("not an array");
  } catch {
    return { error: "Conditions must be valid JSON array, e.g. [{\"field\":\"page_count\",\"operator\":\"gt\",\"value\":20}]" };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("policy_rules").insert({
    policy_id: policyId,
    action,
    conditions: conditions as unknown as Json,
    reason_label: reasonLabel,
    priority,
  });
  if (error) return { error: error.message };

  revalidatePath(routes.adminPolicies);
  return {};
}

export async function toggleRuleEnabledAction(_prev: PolicyActionState, formData: FormData): Promise<PolicyActionState> {
  await requireOrgRole(["org_admin"]);
  const ruleId = String(formData.get("ruleId") ?? "");
  const enabled = formData.get("enabled") === "true";

  const supabase = await createClient();
  const { error } = await supabase.from("policy_rules").update({ enabled: !enabled }).eq("id", ruleId);
  if (error) return { error: error.message };

  revalidatePath(routes.adminPolicies);
  return {};
}
