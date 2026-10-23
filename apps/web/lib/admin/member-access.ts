import { evaluatePolicy, type JobFacts, type OrgRole, type PolicyAction, type PolicyRule } from "@printio/shared";

/**
 * What one person can actually use, in plain words, from the real data model.
 *
 * There is no per-person printer list in Printio. Who may print where is decided by the print rules
 * (policy_rules, matched on role / department / group / printer / job details) and the organization's
 * default answer when no rule matches (organization_settings.default_policy_action). So "which printers can
 * this person use" is the EFFECTIVE result: the same evaluatePolicy() the print path runs, once per printer,
 * for this person's real role, department and groups. Job details (pages, colour, time of day) are fixed to a
 * normal 1-page black and white print, and `jobDependent` says when a rule cares about them.
 *
 * (print_policies.applies_to_role exists in the schema but the print path does not read it, so it is ignored
 * here too - showing it would not match what really happens.)
 */
export type AccessRule = PolicyRule;

export type AccessOutcome = "allowed" | "approval" | "blocked";

export interface MemberAccessInput {
  member: { userId: string; role: OrgRole; department: string | null; groups: { id: string; name: string }[] };
  printers: { id: string; name: string }[];
  rules: AccessRule[];
  defaultAction: PolicyAction;
  adminsBypassRestrictions: boolean;
}

export interface MemberAccess {
  groups: string[];
  printers: { id: string; name: string; outcome: AccessOutcome; why: string }[];
  /** An organization admin and "admins are not held to the rules" is on: every printer is allowed. */
  adminBypass: boolean;
  /** Some enabled rule looks at the job itself (pages, colour, time...), so the answer can differ per job. */
  jobDependent: boolean;
}

const PERSON_FIELDS = new Set(["role", "userId", "groupIds", "department", "printerId"]);

const OUTCOME: Record<PolicyAction, AccessOutcome> = { allow: "allowed", require_approval: "approval", deny: "blocked" };

export function describeMemberAccess(input: MemberAccessInput): MemberAccess {
  const { member, printers, rules, defaultAction, adminsBypassRestrictions } = input;
  const adminBypass = member.role === "org_admin" && adminsBypassRestrictions;
  const jobDependent = rules.some((r) => r.enabled && r.conditions.some((c) => !PERSON_FIELDS.has(c.field)));

  const outcomes = printers.map((p) => {
    const facts: JobFacts = {
      role: member.role,
      userId: member.userId,
      groupIds: member.groups.map((g) => g.id),
      department: member.department,
      printerId: p.id,
      pageCount: 1,
      copies: 1,
      colorMode: "bw",
      duplex: false,
      paperSize: "letter",
      finishingStaple: false,
      finishingBooklet: false,
      finishingPunch: false,
      estimatedPhysicalSheets: 1,
      estimatedCostCents: null,
      timeOfDayMinutes: 12 * 60,
      dayOfWeek: 2,
      monthlyQuotaUsagePct: null,
    };
    const result = evaluatePolicy(facts, rules, defaultAction);
    if (adminBypass) {
      return { id: p.id, name: p.name, outcome: "allowed" as const, why: "Administrators are not held to the print rules." };
    }
    const why = result.usedDefault
      ? `No rule covers this, so the organization default applies (${defaultAction === "allow" ? "allowed" : defaultAction === "deny" ? "blocked" : "needs approval"}).`
      : result.reasons.join(" ");
    return { id: p.id, name: p.name, outcome: OUTCOME[result.action], why };
  });

  return { groups: member.groups.map((g) => g.name), printers: outcomes, adminBypass, jobDependent };
}
