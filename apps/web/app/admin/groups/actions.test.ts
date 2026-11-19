import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => ({ userId: "admin-1", membership: { organization_id: "org-1", role: "org_admin" } }),
}));
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));

import { addGroupMemberAction, createGroupAction, listGroupMembersAction, removeGroupMemberAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const audits = () => fake.calls.filter((c) => c.table === "audit_logs").map((c) => c.values as { action: string });

function setup(opts: { groupOrg?: string; personInOrg?: boolean }) {
  fake = fakeSupabase((c: FakeCall) => {
    if (c.table === "groups" && c.op === "select") return ok({ organization_id: opts.groupOrg ?? "org-1" });
    if (c.table === "organization_members") return ok(opts.personInOrg === false ? null : { user_id: "u1" });
    if (c.table === "groups" && c.op === "insert") return ok({ id: "g1" });
    return ok();
  });
}

beforeEach(() => setup({}));

describe("group actions", () => {
  it("adds a member of this organization and audits it", async () => {
    expect(await addGroupMemberAction({}, fd({ groupId: "g1", userId: "u1" }))).toEqual({});
    expect(fake.calls.some((c) => c.table === "group_members" && c.op === "insert")).toBe(true);
    expect(audits()).toEqual([expect.objectContaining({ action: "group.member_added" })]);
  });
  it("refuses a person who is not in this organization", async () => {
    setup({ personInOrg: false });
    const res = await addGroupMemberAction({}, fd({ groupId: "g1", userId: "stranger" }));
    expect(res.error).toBeTruthy();
    expect(fake.calls.some((c) => c.op === "insert")).toBe(false);
  });
  it("refuses a group from another organization", async () => {
    setup({ groupOrg: "org-2" });
    expect((await addGroupMemberAction({}, fd({ groupId: "g9", userId: "u1" }))).error).toBeTruthy();
    expect((await removeGroupMemberAction({}, fd({ groupId: "g9", userId: "u1" }))).error).toBeTruthy();
    expect(await listGroupMembersAction({ groupId: "g9" })).toBeNull();
    expect(fake.calls.some((c) => c.op === "insert" || c.op === "delete")).toBe(false);
  });
  it("audits create and remove", async () => {
    await createGroupAction({}, fd({ name: "Science", kind: "department" }));
    await removeGroupMemberAction({}, fd({ groupId: "g1", userId: "u1" }));
    expect(audits().map((a) => a.action)).toEqual(["group.created", "group.member_removed"]);
  });
});
