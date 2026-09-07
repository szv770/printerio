import { describe, it, expect } from "vitest";
import { checkSuperAdminDemotion, escapeLikePattern, normalizeEmail } from "./super-admins";

describe("checkSuperAdminDemotion", () => {
  it("blocks demoting yourself even when other super admins exist", () => {
    const result = checkSuperAdminDemotion({ targetUserId: "u1", actingUserId: "u1", totalSuperAdmins: 3 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/own/i);
  });

  it("blocks demoting the last remaining super admin", () => {
    const result = checkSuperAdminDemotion({ targetUserId: "u2", actingUserId: "u1", totalSuperAdmins: 1 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/last super admin/i);
  });

  it("allows demoting someone else when more than one super admin remains", () => {
    const result = checkSuperAdminDemotion({ targetUserId: "u2", actingUserId: "u1", totalSuperAdmins: 2 });
    expect(result).toEqual({ allowed: true });
  });

  it("prioritizes the self-demotion message when both guards would fire", () => {
    // Sole super admin trying to demote themselves - either message would be
    // technically true, but "you can't demote yourself" is the more directly
    // actionable one (promoting someone else first doesn't even apply here).
    const result = checkSuperAdminDemotion({ targetUserId: "u1", actingUserId: "u1", totalSuperAdmins: 1 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/own/i);
  });
});

describe("escapeLikePattern", () => {
  it("escapes percent and underscore wildcards", () => {
    expect(escapeLikePattern("50%off_deal")).toBe("50\\%off\\_deal");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves ordinary email characters untouched", () => {
    expect(escapeLikePattern("svogel@lecfl.com")).toBe("svogel@lecfl.com");
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  SVogel@LECFL.com  ")).toBe("svogel@lecfl.com");
  });
});
