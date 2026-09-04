/**
 * Print policy / rules engine - pure, synchronous, no I/O.
 *
 * See docs/architecture.md sec 6 for the full design rationale. Summary:
 *  - A rule's `conditions` are implicitly AND-ed.
 *  - OR-across-different-criteria is expressed as multiple rules in the same
 *    action tier (e.g. six separate REQUIRE_APPROVAL rules for "color OR >20
 *    pages OR >5 copies OR ..."), not as boolean expressions inside one rule.
 *  - Precedence is by tier, not by rule order: DENY > REQUIRE_APPROVAL > ALLOW
 *    > organization default. Within the winning tier, every matching rule's
 *    reason is collected (not just the first), which is what produces the
 *    spec's example multi-reason admin output.
 *
 * The caller (a Server Action) is responsible for assembling `JobFacts` from
 * verified server-side data (preflight result, quota lookup, etc.) - this
 * module never trusts or accepts raw client input itself.
 */

export type PolicyAction = "allow" | "require_approval" | "deny";

export type OrgRole = "org_admin" | "approver" | "staff" | "student";

/**
 * The complete set of facts a rule condition may inspect. Keep this in sync
 * with the `field` values accepted by `evaluateCondition` below - adding a new
 * fact means adding it here, wiring it into the caller that builds JobFacts,
 * and (if it should be selectable in the admin rule builder) adding it there.
 */
export interface JobFacts {
  role: OrgRole;
  userId: string;
  groupIds: string[];
  department: string | null;
  printerId: string | null;
  /** Server-verified source PDF page count (never client-supplied). */
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
  /** Minutes since local midnight (0-1439), for time-of-day rules. */
  timeOfDayMinutes: number;
  /** 0 = Sunday ... 6 = Saturday. */
  dayOfWeek: number;
  /** 0-100, or null if quotas aren't configured for this user/scope. */
  monthlyQuotaUsagePct: number | null;
}

export type JobFactField = keyof JobFacts;

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains" // fact is an array; value must be one of its elements
  | "between"; // value is [min, max], inclusive

export interface RuleCondition {
  field: JobFactField;
  operator: ConditionOperator;
  value: unknown;
}

export interface PolicyRule {
  id: string;
  /** Implicitly AND-ed. An empty array matches every job (use with care). */
  conditions: RuleCondition[];
  action: PolicyAction;
  reasonLabel: string;
  /** Only orders reason display within a tier; does not affect which tier wins. */
  priority: number;
  enabled: boolean;
}

export interface PolicyEvaluationResult {
  action: PolicyAction;
  /** Deduplicated, ordered by rule priority. Always non-empty. */
  reasons: string[];
  matchedRuleIds: string[];
  /** True if no rule matched and the organization default action was used. */
  usedDefault: boolean;
}

function evaluateCondition(factValue: unknown, condition: RuleCondition): boolean {
  const { operator, value } = condition;
  switch (operator) {
    case "eq":
      return factValue === value;
    case "neq":
      return factValue !== value;
    case "gt":
      return typeof factValue === "number" && typeof value === "number" && factValue > value;
    case "gte":
      return typeof factValue === "number" && typeof value === "number" && factValue >= value;
    case "lt":
      return typeof factValue === "number" && typeof value === "number" && factValue < value;
    case "lte":
      return typeof factValue === "number" && typeof value === "number" && factValue <= value;
    case "in":
      return Array.isArray(value) && value.includes(factValue);
    case "not_in":
      return Array.isArray(value) && !value.includes(factValue);
    case "contains":
      return Array.isArray(factValue) && factValue.includes(value);
    case "between": {
      if (!Array.isArray(value) || value.length !== 2 || typeof factValue !== "number") return false;
      const [min, max] = value as [number, number];
      return factValue >= min && factValue <= max;
    }
    default:
      return false;
  }
}

function ruleMatches(facts: JobFacts, rule: PolicyRule): boolean {
  if (!rule.enabled) return false;
  return rule.conditions.every((condition) => evaluateCondition(facts[condition.field], condition));
}

const TIER_ORDER: PolicyAction[] = ["deny", "require_approval", "allow"];

/**
 * Evaluate every enabled rule against `facts` and resolve the deterministic
 * precedence model documented in docs/architecture.md sec 6.3.
 *
 * @param defaultAction organization_settings.default_policy_action, used only
 *   when nothing matches. Fail-safe default upstream is `require_approval`.
 */
export function evaluatePolicy(
  facts: JobFacts,
  rules: PolicyRule[],
  defaultAction: PolicyAction,
): PolicyEvaluationResult {
  for (const tier of TIER_ORDER) {
    const matched = rules
      .filter((r) => r.action === tier && ruleMatches(facts, r))
      .sort((a, b) => a.priority - b.priority);

    if (matched.length > 0) {
      const reasons: string[] = [];
      for (const rule of matched) {
        if (!reasons.includes(rule.reasonLabel)) reasons.push(rule.reasonLabel);
      }
      return {
        action: tier,
        reasons,
        matchedRuleIds: matched.map((r) => r.id),
        usedDefault: false,
      };
    }
  }

  return {
    action: defaultAction,
    reasons: ["No matching rule; organization default policy applied."],
    matchedRuleIds: [],
    usedDefault: true,
  };
}
