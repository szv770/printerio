import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const ACTOR = "admin-1";
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => ({ userId: ACTOR, membership: { organization_id: "org-1", role: "org_admin" } }),
}));

let fake: ReturnType<typeof fakeSupabase>;
let respond: (c: FakeCall) => FakeResult;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));

import { changeMemberRoleAction, toggleMemberStatusAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const target = (over: Record<string, unknown> = {}) => ({ user_id: "u2", role: "org_admin", status: "active", ...over });
/** `adminCount` = how many active org_admins exist; `row` = the member being changed (null = not found). */
function setup(adminCount: number, row: Record<string, unknown> | null = target()) {
  respond = (c) => {
    if (c.table === "organization_members" && c.op === "select") {
      return c.single ? ok(row) : { data: null, error: null, count: adminCount };
    }
    return ok();
  };
  fake = fakeSupabase((c) => respond(c));
}
const updates = () => fake.calls.filter((c) => c.table === "organization_members" && c.op === "update");
const audits = () => fake.calls.filter((c) => c.table === "audit_logs");

beforeEach(() => setup(2));

describe("changeMemberRoleAction", () => {
  it("refuses to demote the only active org_admin, writes nothing and says why", async () => {
    setup(1);
    const res = await changeMemberRoleAction({}, fd({ userId: "u2", role: "staff" }));
    expect(res.error).toMatch(/only remaining org admin/i);
    expect(updates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("also refuses when an admin demotes themselves and they are the last one", async () => {
    setup(1, target({ user_id: ACTOR }));
    const res = await changeMemberRoleAction({}, fd({ userId: ACTOR, role: "student" }));
    expect(res.error).toBeTruthy();
    expect(updates()).toHaveLength(0);
  });

  it("allows a demotion while another active org_admin remains", async () => {
    setup(2);
    const res = await changeMemberRoleAction({}, fd({ userId: "u2", role: "staff" }));
    expect(res).toEqual({});
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.values).toEqual({ role: "staff" });
    expect(audits()).toHaveLength(1);
  });

  it("does not block changing a non-admin, or setting org_admin on the only admin (no-op)", async () => {
    setup(1, target({ role: "staff" }));
    expect(await changeMemberRoleAction({}, fd({ userId: "u2", role: "approver" }))).toEqual({});
    setup(1);
    expect(await changeMemberRoleAction({}, fd({ userId: "u2", role: "org_admin" }))).toEqual({});
  });

  it("still rejects an invalid role and an unknown member without writing", async () => {
    expect((await changeMemberRoleAction({}, fd({ userId: "u2", role: "root" }))).error).toMatch(/invalid role/i);
    setup(2, null);
    expect((await changeMemberRoleAction({}, fd({ userId: "ghost", role: "staff" }))).error).toMatch(/no longer in this organization/i);
    expect(updates()).toHaveLength(0);
  });

  it("counts only active org_admins of this organization", async () => {
    setup(2);
    await changeMemberRoleAction({}, fd({ userId: "u2", role: "staff" }));
    const count = fake.calls.find((c) => c.table === "organization_members" && c.columns === "user_id")!;
    expect(count.filters).toEqual(expect.arrayContaining([["eq", "organization_id", "org-1"], ["eq", "role", "org_admin"], ["eq", "status", "active"]]));
  });
});

describe("toggleMemberStatusAction", () => {
  it("refuses to disable the only active org_admin", async () => {
    setup(1);
    const res = await toggleMemberStatusAction({}, fd({ userId: "u2", status: "disabled" }));
    expect(res.error).toMatch(/only remaining org admin/i);
    expect(updates()).toHaveLength(0);
  });
  it("disables an admin when another remains, and re-enabling is never blocked", async () => {
    setup(2);
    expect(await toggleMemberStatusAction({}, fd({ userId: "u2", status: "disabled" }))).toEqual({});
    setup(0, target({ status: "disabled" }));
    expect(await toggleMemberStatusAction({}, fd({ userId: "u2", status: "active" }))).toEqual({});
  });
  it("still blocks disabling yourself", async () => {
    setup(3, target({ user_id: ACTOR }));
    expect((await toggleMemberStatusAction({}, fd({ userId: ACTOR, status: "disabled" }))).error).toMatch(/your own account/i);
  });
});
