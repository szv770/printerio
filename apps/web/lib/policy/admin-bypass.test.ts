import { describe, expect, it } from "vitest";
import { approverSkipsApproval, didBypassChangeOutcome, isAdminExemptFromRestrictions } from "./admin-bypass";

describe("isAdminExemptFromRestrictions", () => {
  it("is exempt when org_admin and the org has bypass enabled (the default)", () => {
    expect(isAdminExemptFromRestrictions("org_admin", true)).toBe(true);
  });

  it("is NOT exempt when the org deliberately disabled the bypass", () => {
    expect(isAdminExemptFromRestrictions("org_admin", false)).toBe(false);
  });

  it("never exempts a non-admin role, even if the org left bypass enabled", () => {
    expect(isAdminExemptFromRestrictions("staff", true)).toBe(false);
    expect(isAdminExemptFromRestrictions("approver", true)).toBe(false);
    expect(isAdminExemptFromRestrictions("student", true)).toBe(false);
  });
});

describe("didBypassChangeOutcome", () => {
  it("is false when not exempt, regardless of policy action", () => {
    expect(didBypassChangeOutcome(false, "deny")).toBe(false);
    expect(didBypassChangeOutcome(false, "require_approval")).toBe(false);
  });

  it("is false when exempt but the policy would have allowed it anyway - nothing was overridden", () => {
    expect(didBypassChangeOutcome(true, "allow")).toBe(false);
  });

  it("is true when exempt and the policy would otherwise have denied or required approval", () => {
    expect(didBypassChangeOutcome(true, "deny")).toBe(true);
    expect(didBypassChangeOutcome(true, "require_approval")).toBe(true);
  });
});

describe("approverSkipsApproval", () => {
  it("is true only for an approver whose job would otherwise wait for approval", () => {
    expect(approverSkipsApproval("approver", "require_approval")).toBe(true);
  });
  it("never lifts a denial or helps anyone else", () => {
    expect(approverSkipsApproval("approver", "deny")).toBe(false);
    expect(approverSkipsApproval("approver", "allow")).toBe(false);
    for (const role of ["staff", "student", "org_admin"] as const) expect(approverSkipsApproval(role, "require_approval")).toBe(false);
  });
});
