import { describe, expect, it } from "vitest";
import { evaluatePolicy, type JobFacts, type PolicyRule } from "./policy-engine.js";

function facts(overrides: Partial<JobFacts> = {}): JobFacts {
  return {
    role: "staff",
    userId: "u1",
    groupIds: [],
    department: null,
    printerId: "p1",
    pageCount: 10,
    copies: 1,
    colorMode: "bw",
    duplex: true,
    paperSize: "letter",
    finishingStaple: false,
    finishingBooklet: false,
    finishingPunch: false,
    estimatedPhysicalSheets: 5,
    estimatedCostCents: null,
    timeOfDayMinutes: 600,
    dayOfWeek: 2,
    monthlyQuotaUsagePct: 10,
    ...overrides,
  };
}

// Rules mirroring the spec's staff policy example (docs/architecture.md sec 6.2):
// staff auto-allow envelope, plus six single-purpose REQUIRE_APPROVAL rules for
// the "OR" conditions, plus a student-always-approval rule and an explicit deny.
const rules: PolicyRule[] = [
  {
    id: "deny-oversized",
    action: "deny",
    conditions: [{ field: "estimatedPhysicalSheets", operator: "gt", value: 500 }],
    reasonLabel: "Job exceeds the organization's maximum job size",
    priority: 0,
    enabled: true,
  },
  {
    id: "student-always-approval",
    action: "require_approval",
    conditions: [{ field: "role", operator: "eq", value: "student" }],
    reasonLabel: "Student account",
    priority: 10,
    enabled: true,
  },
  {
    id: "staff-color",
    action: "require_approval",
    conditions: [{ field: "colorMode", operator: "eq", value: "color" }],
    reasonLabel: "Color printing requires approval",
    priority: 20,
    enabled: true,
  },
  {
    id: "staff-pages",
    action: "require_approval",
    conditions: [{ field: "pageCount", operator: "gt", value: 20 }],
    reasonLabel: "Exceeds 20-page staff threshold",
    priority: 21,
    enabled: true,
  },
  {
    id: "staff-copies",
    action: "require_approval",
    conditions: [{ field: "copies", operator: "gt", value: 5 }],
    reasonLabel: "Exceeds 5-copy staff threshold",
    priority: 22,
    enabled: true,
  },
  {
    id: "staff-11x17",
    action: "require_approval",
    conditions: [{ field: "paperSize", operator: "eq", value: "11x17" }],
    reasonLabel: "11x17 requires approval",
    priority: 23,
    enabled: true,
  },
  {
    id: "staff-booklet",
    action: "require_approval",
    conditions: [{ field: "finishingBooklet", operator: "eq", value: true }],
    reasonLabel: "Booklet requires approval",
    priority: 24,
    enabled: true,
  },
  {
    id: "staff-staple",
    action: "require_approval",
    conditions: [{ field: "finishingStaple", operator: "eq", value: true }],
    reasonLabel: "Stapling requires approval",
    priority: 25,
    enabled: true,
  },
  {
    id: "staff-auto-allow",
    action: "allow",
    conditions: [
      { field: "role", operator: "eq", value: "staff" },
      { field: "colorMode", operator: "eq", value: "bw" },
      { field: "pageCount", operator: "lte", value: 20 },
      { field: "copies", operator: "lte", value: 5 },
      { field: "paperSize", operator: "in", value: ["letter", "a4"] },
      { field: "finishingBooklet", operator: "eq", value: false },
      { field: "finishingStaple", operator: "eq", value: false },
    ],
    reasonLabel: "Staff job within auto-approve envelope",
    priority: 30,
    enabled: true,
  },
];

describe("evaluatePolicy", () => {
  it("auto-allows a staff job within the envelope", () => {
    const result = evaluatePolicy(facts({ role: "staff", pageCount: 10 }), rules, "require_approval");
    expect(result.action).toBe("allow");
    expect(result.usedDefault).toBe(false);
  });

  it("requires approval for a staff job over the page threshold, with the specific reason", () => {
    const result = evaluatePolicy(facts({ role: "staff", pageCount: 37 }), rules, "require_approval");
    expect(result.action).toBe("require_approval");
    expect(result.reasons).toEqual(["Exceeds 20-page staff threshold"]);
  });

  it("aggregates every matching reason in the winning tier (spec's multi-reason example)", () => {
    const result = evaluatePolicy(
      facts({ role: "student", pageCount: 37, colorMode: "color" }),
      rules,
      "require_approval",
    );
    expect(result.action).toBe("require_approval");
    // Order follows rule priority: student(10) < color(20) < pages(21).
    expect(result.reasons).toEqual([
      "Student account",
      "Color printing requires approval",
      "Exceeds 20-page staff threshold",
    ]);
  });

  it("DENY takes precedence over REQUIRE_APPROVAL and ALLOW even if both also match", () => {
    const result = evaluatePolicy(
      facts({ role: "student", estimatedPhysicalSheets: 501 }),
      rules,
      "require_approval",
    );
    expect(result.action).toBe("deny");
    expect(result.reasons).toEqual(["Job exceeds the organization's maximum job size"]);
  });

  it("falls back to the organization default when nothing matches", () => {
    // A role with no explicit rule at all and no envelope match.
    const result = evaluatePolicy(
      facts({ role: "approver", pageCount: 10, colorMode: "bw" }),
      rules,
      "allow",
    );
    expect(result.action).toBe("allow");
    expect(result.usedDefault).toBe(true);
    expect(result.matchedRuleIds).toEqual([]);
  });

  it("does not duplicate a reason if multiple matched rules happen to share one", () => {
    const dupeRules: PolicyRule[] = [
      { id: "a", action: "require_approval", conditions: [{ field: "colorMode", operator: "eq", value: "color" }], reasonLabel: "Color", priority: 1, enabled: true },
      { id: "b", action: "require_approval", conditions: [{ field: "pageCount", operator: "gt", value: 5 }], reasonLabel: "Color", priority: 2, enabled: true },
    ];
    const result = evaluatePolicy(facts({ colorMode: "color", pageCount: 10 }), dupeRules, "deny");
    expect(result.reasons).toEqual(["Color"]);
  });

  it("ignores disabled rules", () => {
    const disabled: PolicyRule[] = [
      { id: "a", action: "deny", conditions: [], reasonLabel: "should not fire", priority: 1, enabled: false },
    ];
    const result = evaluatePolicy(facts(), disabled, "allow");
    expect(result.action).toBe("allow");
    expect(result.usedDefault).toBe(true);
  });
});
