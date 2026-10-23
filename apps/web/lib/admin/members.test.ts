import { describe, expect, it } from "vitest";
import {
  changedMembers,
  filterMembers,
  memberActionFields,
  memberChangeActions,
  roleChoices,
  type MemberDraft,
  type MemberListItem,
} from "./members";

const base: MemberDraft = { role: "staff", department: "Math", userCode: "", status: "active" };

describe("memberChangeActions", () => {
  it("is empty when nothing changed", () => {
    expect(memberChangeActions(base, { ...base })).toEqual([]);
  });
  it("lists each changed field as the existing action that saves it, in a fixed order", () => {
    const draft: MemberDraft = { role: "approver", department: "Art", userCode: "AB12", status: "disabled" };
    expect(memberChangeActions(base, draft)).toEqual(["role", "department", "userCode", "status"]);
  });
  it("ignores surrounding spaces and code letter case", () => {
    expect(memberChangeActions(base, { ...base, department: "  Math " })).toEqual([]);
    expect(memberChangeActions({ ...base, userCode: "ab12" }, { ...base, userCode: "AB12 " })).toEqual([]);
  });
  it("treats clearing a department as a change", () => {
    expect(memberChangeActions(base, { ...base, department: "" })).toEqual(["department"]);
  });
});

describe("changedMembers", () => {
  it("returns only the members that differ, with their actions", () => {
    const baselines = { a: base, b: base };
    const drafts = { a: base, b: { ...base, role: "student" } };
    expect(changedMembers(baselines, drafts)).toEqual([{ userId: "b", actions: ["role"] }]);
  });
  it("skips members that have no draft", () => {
    expect(changedMembers({ a: base }, {})).toEqual([]);
  });
});

describe("memberActionFields", () => {
  const d: MemberDraft = { role: "approver", department: " Art ", userCode: "ab12", status: "disabled" };
  it("matches what each server action reads", () => {
    expect(memberActionFields("role", "u1", d)).toEqual({ userId: "u1", role: "approver" });
    expect(memberActionFields("department", "u1", d)).toEqual({ userId: "u1", department: "Art" });
    expect(memberActionFields("userCode", "u1", d)).toEqual({ userId: "u1", userCode: "ab12" });
    expect(memberActionFields("status", "u1", d)).toEqual({ userId: "u1", status: "disabled" });
  });
});

describe("filterMembers", () => {
  const people: MemberListItem[] = [
    { userId: "1", displayName: "Dana Kaplan", email: "dana@x.org", role: "staff", status: "active", department: "Math", code: "DK1" },
    { userId: "2", displayName: null, email: "lev@x.org", role: "org_admin", status: "disabled", department: null, code: "LV2" },
    { userId: "3", displayName: "Moshe", email: "m@x.org", role: "student", status: "active", department: "Art", code: "M3" },
  ];
  it("returns everyone for an empty search", () => {
    expect(filterMembers(people, { query: "  " }).length).toBe(3);
  });
  it("searches name, email, department and code, ignoring case", () => {
    expect(filterMembers(people, { query: "kaplan" }).map((p) => p.userId)).toEqual(["1"]);
    expect(filterMembers(people, { query: "LEV@" }).map((p) => p.userId)).toEqual(["2"]);
    expect(filterMembers(people, { query: "art" }).map((p) => p.userId)).toEqual(["3"]);
    expect(filterMembers(people, { query: "dk1" }).map((p) => p.userId)).toEqual(["1"]);
  });
  it("combines the search with role and status filters", () => {
    expect(filterMembers(people, { query: "", role: "org_admin" }).map((p) => p.userId)).toEqual(["2"]);
    expect(filterMembers(people, { query: "", status: "active" }).map((p) => p.userId)).toEqual(["1", "3"]);
    expect(filterMembers(people, { query: "x.org", role: "staff", status: "active" }).map((p) => p.userId)).toEqual(["1"]);
  });
});

describe("roleChoices", () => {
  it("uses the on-screen names and never says Student", () => {
    const labels = roleChoices().map((r) => r.label);
    expect(labels).toEqual(["User", "Staff", "Approver", "Admin"]);
    expect(roleChoices().map((r) => r.value)).toEqual(["student", "staff", "approver", "org_admin"]);
  });
});
