import { describe, expect, it } from "vitest";
import { describeMemberAccess, type AccessRule } from "./member-access";

const P1 = { id: "p1", name: "Main office" };
const P2 = { id: "p2", name: "Library" };
const member = { userId: "u1", role: "student" as const, department: "Grade 5", groups: [{ id: "g1", name: "Grade 5 teachers" }] };
const rule = (o: Partial<AccessRule>): AccessRule => ({ id: "r", conditions: [], action: "allow", reasonLabel: "Because", priority: 100, enabled: true, ...o });
const run = (rules: AccessRule[], extra: Partial<Parameters<typeof describeMemberAccess>[0]> = {}) =>
  describeMemberAccess({ member, printers: [P1, P2], rules, defaultAction: "require_approval", adminsBypassRestrictions: true, ...extra });

describe("describeMemberAccess", () => {
  it("lists the groups by name", () => {
    expect(run([]).groups).toEqual(["Grade 5 teachers"]);
  });
  it("uses the organization default when no rule matches", () => {
    const r = run([]);
    expect(r.printers.map((p) => p.outcome)).toEqual(["approval", "approval"]);
    expect(r.printers[0]!.why).toMatch(/default/i);
  });
  it("applies a rule that targets this person's group", () => {
    const r = run([rule({ conditions: [{ field: "groupIds", operator: "contains", value: "g1" }], reasonLabel: "Grade 5 may print" })]);
    expect(r.printers.map((p) => p.outcome)).toEqual(["allowed", "allowed"]);
    expect(r.printers[0]!.why).toBe("Grade 5 may print");
  });
  it("applies a rule for one printer only", () => {
    const r = run([rule({ action: "deny", conditions: [{ field: "printerId", operator: "eq", value: "p2" }], reasonLabel: "Library is staff only" })], { defaultAction: "allow" });
    expect(r.printers.map((p) => [p.name, p.outcome])).toEqual([["Main office", "allowed"], ["Library", "blocked"]]);
    expect(r.printers[1]!.why).toBe("Library is staff only");
  });
  it("ignores rules for other groups and disabled rules", () => {
    const r = run([
      rule({ action: "deny", conditions: [{ field: "groupIds", operator: "contains", value: "other" }] }),
      rule({ action: "deny", enabled: false }),
    ], { defaultAction: "allow" });
    expect(r.printers.every((p) => p.outcome === "allowed")).toBe(true);
  });
  it("notes rules that depend on the job, and says the check is for a normal 1-page black and white print", () => {
    const r = run([rule({ action: "deny", conditions: [{ field: "pageCount", operator: "gt", value: 50 }] })], { defaultAction: "allow" });
    expect(r.printers.every((p) => p.outcome === "allowed")).toBe(true);
    expect(r.jobDependent).toBe(true);
    expect(run([]).jobDependent).toBe(false);
  });
  it("admins are not held to the rules while the bypass setting is on", () => {
    const admin = { ...member, role: "org_admin" as const };
    const held = run([rule({ action: "deny" })], { member: admin, adminsBypassRestrictions: false });
    expect(held.printers[0]!.outcome).toBe("blocked");
    expect(held.adminBypass).toBe(false);
    const free = run([rule({ action: "deny" })], { member: admin });
    expect(free.adminBypass).toBe(true);
    expect(free.printers.every((p) => p.outcome === "allowed")).toBe(true);
  });
});
