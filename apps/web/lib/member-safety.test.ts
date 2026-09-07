import { describe, it, expect } from "vitest";
import { assertCanDisableSelf, assertCanRemoveMember, type MemberSafetyMember } from "./member-safety";

describe("assertCanDisableSelf", () => {
  it("blocks an actor disabling their own account", () => {
    expect(assertCanDisableSelf("user-1", "user-1")).toEqual(expect.any(String));
  });

  it("allows an actor disabling someone else's account", () => {
    expect(assertCanDisableSelf("user-1", "user-2")).toBeNull();
  });
});

describe("assertCanRemoveMember", () => {
  const admin = (overrides: Partial<MemberSafetyMember> = {}): MemberSafetyMember => ({
    userId: "user-1",
    role: "org_admin",
    status: "active",
    ...overrides,
  });

  it("blocks removing the only remaining active org admin", () => {
    expect(assertCanRemoveMember(admin(), 1)).toEqual(expect.any(String));
  });

  it("blocks even when the count comes back as zero or negative (defensive)", () => {
    expect(assertCanRemoveMember(admin(), 0)).toEqual(expect.any(String));
  });

  it("allows removing an org admin when other active admins remain", () => {
    expect(assertCanRemoveMember(admin(), 2)).toBeNull();
  });

  it("allows removing a non-admin regardless of the active admin count", () => {
    expect(assertCanRemoveMember(admin({ role: "student" }), 1)).toBeNull();
  });

  it("allows removing an org admin whose membership is already disabled", () => {
    expect(assertCanRemoveMember(admin({ status: "disabled" }), 1)).toBeNull();
  });
});
