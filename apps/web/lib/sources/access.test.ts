import { describe, expect, it } from "vitest";
import { canUseLinks } from "./access";

describe("canUseLinks (link import and the booklet builder)", () => {
  it("is on for admins", () => {
    expect(canUseLinks("org_admin")).toBe(true);
    expect(canUseLinks("org_admin", false)).toBe(true);
  });
  it("is off for everyone else by default", () => {
    for (const role of ["approver", "staff", "student", null, undefined]) expect(canUseLinks(role)).toBe(false);
  });
  it("is on for a person an admin switched early tools on for, whatever their role", () => {
    for (const role of ["approver", "staff", "student"]) expect(canUseLinks(role, true)).toBe(true);
  });
  it("treats anything other than an explicit true as off", () => {
    expect(canUseLinks("staff", false)).toBe(false);
    expect(canUseLinks("staff", null)).toBe(false);
    expect(canUseLinks("staff", undefined)).toBe(false);
  });
});
