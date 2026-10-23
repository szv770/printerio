import { describe, it, expect } from "vitest";
import { assertCanDemoteMember, assertCanDisableMember, assertCanDisableSelf, assertCanRemoveMember, type MemberSafetyMember } from "./member-safety";

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

describe("assertCanDemoteMember", () => {
  const admin = (over: Partial<MemberSafetyMember> = {}): MemberSafetyMember => ({ userId: "u1", role: "org_admin", status: "active", ...over });
  it("blocks demoting the only active org_admin, to any other role", () => {
    for (const role of ["approver", "staff", "student"]) {
      expect(assertCanDemoteMember(admin(), role, 1)).toEqual(expect.any(String));
    }
    expect(assertCanDemoteMember(admin(), "staff", 0)).toEqual(expect.any(String));
  });
  it("allows it when another active org_admin remains", () => {
    expect(assertCanDemoteMember(admin(), "staff", 2)).toBeNull();
  });
  it("allows keeping org_admin (a no-op) and changing anyone who is not an active org_admin", () => {
    expect(assertCanDemoteMember(admin(), "org_admin", 1)).toBeNull();
    expect(assertCanDemoteMember(admin({ role: "staff" }), "student", 1)).toBeNull();
    expect(assertCanDemoteMember(admin({ status: "disabled" }), "staff", 1)).toBeNull();
  });
});

describe("assertCanDisableMember", () => {
  const admin = (over: Partial<MemberSafetyMember> = {}): MemberSafetyMember => ({ userId: "u1", role: "org_admin", status: "active", ...over });
  it("blocks disabling the only active org_admin", () => {
    expect(assertCanDisableMember(admin(), 1)).toEqual(expect.any(String));
  });
  it("allows it with another admin left, or for non-admins and already-disabled admins", () => {
    expect(assertCanDisableMember(admin(), 2)).toBeNull();
    expect(assertCanDisableMember(admin({ role: "staff" }), 1)).toBeNull();
    expect(assertCanDisableMember(admin({ status: "disabled" }), 1)).toBeNull();
  });
});
