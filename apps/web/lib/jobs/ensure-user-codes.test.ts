import { describe, expect, it } from "vitest";
import { fakeSupabase, ok, type FakeCall } from "@/test/fake-supabase";
import { ensureMemberUserCodes } from "./ensure-user-codes";

describe("ensureMemberUserCodes", () => {
  it("reads used codes once, guards each write with user_code IS NULL and scopes to the organization", async () => {
    const fake = fakeSupabase((c: FakeCall) => {
      if (c.op === "select") return ok([{ user_code: "DK1" }]);
      return ok([{ user_code: "x" }]);
    });
    const members = [{ userId: "u1", displayName: "Dana Kaplan", email: null }, { userId: "u2", displayName: "Dan Klein", email: null }];
    const res = await ensureMemberUserCodes(fake.client as never, { organizationId: "org-1", members });
    expect(res).toEqual({ assigned: 2, failed: 0 });
    expect(fake.calls.filter((c) => c.op === "select")).toHaveLength(1);
    const updates = fake.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.filters).toContainEqual(["is", "user_code", null]);
      expect(u.filters).toContainEqual(["eq", "organization_id", "org-1"]);
    }
    const codes = updates.map((u) => (u.values as { user_code: string }).user_code);
    expect(new Set(codes).size).toBe(2);
    expect(codes).not.toContain("DK1");
  });
  it("tries the next code on a unique violation and counts failures instead of throwing", async () => {
    let n = 0;
    const fake = fakeSupabase((c) => {
      if (c.op === "select") return ok([]);
      return n++ === 0 ? { data: null, error: { message: "dup", code: "23505" } as never } : ok([{ user_code: "x" }]);
    });
    const res = await ensureMemberUserCodes(fake.client as never, { organizationId: "o", members: [{ userId: "u1", displayName: "A B", email: null }] });
    expect(res.assigned).toBe(1);
    const bad = fakeSupabase((c) => (c.op === "select" ? ok([]) : { data: null, error: { message: "down" } }));
    expect(await ensureMemberUserCodes(bad.client as never, { organizationId: "o", members: [{ userId: "u1", displayName: "A B", email: null }] })).toEqual({ assigned: 0, failed: 1 });
  });
  it("does nothing for nobody", async () => {
    const fake = fakeSupabase(() => ok());
    expect(await ensureMemberUserCodes(fake.client as never, { organizationId: "o", members: [] })).toEqual({ assigned: 0, failed: 0 });
    expect(fake.calls).toHaveLength(0);
  });
});
