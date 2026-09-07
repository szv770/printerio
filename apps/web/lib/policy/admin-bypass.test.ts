import { describe, expect, it } from "vitest";
import { didBypassChangeOutcome, isAdminExemptFromRestrictions } from "./admin-bypass";

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
