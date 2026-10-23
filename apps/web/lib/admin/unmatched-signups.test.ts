import { describe, it, expect, vi } from "vitest";
import { fakeSupabase, ok, failure, type FakeCall } from "@/test/fake-supabase";
import { findUnmatchedSignups, removeUnmatchedSignup } from "./unmatched-signups";

const ORG = "org-1";
const ACTOR = "admin-1";
type U = { id: string; email: string; created_at: string; last_sign_in_at: string | null };
const users: U[] = [
  { id: "admin-1", email: "a@lecfl.com", created_at: "2026-01-01T00:00:00Z", last_sign_in_at: "2026-10-01T00:00:00Z" },
  { id: "member-1", email: "m@lecfl.com", created_at: "2026-02-01T00:00:00Z", last_sign_in_at: null },
  { id: "stranger-1", email: "x@gmail.com", created_at: "2026-10-20T00:00:00Z", last_sign_in_at: "2026-10-21T00:00:00Z" },
  { id: "stranger-2", email: "y@yahoo.com", created_at: "2026-10-22T00:00:00Z", last_sign_in_at: null },
  { id: "root-1", email: "root@x.com", created_at: "2026-03-01T00:00:00Z", last_sign_in_at: null },
];

function make(opts: { memberIds?: string[]; superIds?: string[]; deleteError?: boolean } = {}) {
  const memberIds = opts.memberIds ?? ["admin-1", "member-1"];
  const superIds = opts.superIds ?? ["root-1"];
  const fake = fakeSupabase((c: FakeCall) => {
    if (c.table === "organization_members" && c.op === "select") {
      const ids = (c.filters.find((f) => f[0] === "in")?.[2] as string[]) ?? [];
      return ok(ids.filter((i) => memberIds.includes(i)).map((user_id) => ({ user_id })));
    }
    if (c.table === "profiles" && c.op === "select") {
      const ids = (c.filters.find((f) => f[0] === "in")?.[2] as string[]) ?? [];
      return ok(ids.filter((i) => superIds.includes(i)).map((id) => ({ id })));
    }
    return ok();
  });
  const deleteUser = vi.fn(async () => ({ error: opts.deleteError ? { message: "x" } : null }));
  const listUsers = vi.fn(async ({ page }: { page: number }) => ({ data: { users: page === 1 ? users : [] }, error: null }));
  const client = { ...fake.client, auth: { admin: { listUsers, deleteUser } } } as never;
  return { client, fake, deleteUser, listUsers };
}

describe("findUnmatchedSignups", () => {
  it("returns only accounts with no membership anywhere and not super admins, newest first", async () => {
    const { client } = make();
    const r = await findUnmatchedSignups(client);
    expect(r.map((x) => x.userId)).toEqual(["stranger-2", "stranger-1"]);
    expect(r[1]).toEqual({ userId: "stranger-1", email: "x@gmail.com", signedUpAt: "2026-10-20T00:00:00Z", lastSignInAt: "2026-10-21T00:00:00Z" });
  });
});

describe("removeUnmatchedSignup", () => {
  it("deletes a stranger and writes an audit log with their email", async () => {
    const { client, fake, deleteUser } = make();
    const r = await removeUnmatchedSignup(client, { actorId: ACTOR, organizationId: ORG, targetId: "stranger-1" });
    expect(r).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenCalledWith("stranger-1");
    const audit = fake.calls.find((c) => c.table === "audit_logs" && c.op === "insert")!;
    expect(audit.values).toMatchObject({ organization_id: ORG, actor_id: ACTOR, action: "signup.removed", target_id: "stranger-1", metadata: { email: "x@gmail.com" } });
  });
  it("refuses yourself", async () => {
    const { client, deleteUser } = make({ memberIds: [] });
    const r = await removeUnmatchedSignup(client, { actorId: ACTOR, organizationId: ORG, targetId: ACTOR });
    expect(r.ok).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("refuses a member or admin (of any organization, so never cross-org)", async () => {
    const { client, deleteUser } = make();
    for (const id of ["member-1", "admin-1"]) {
      const r = await removeUnmatchedSignup(client, { actorId: "someone", organizationId: ORG, targetId: id });
      expect(r.ok).toBe(false);
    }
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("refuses a platform super admin and an unknown user", async () => {
    const { client, deleteUser } = make();
    expect((await removeUnmatchedSignup(client, { actorId: ACTOR, organizationId: ORG, targetId: "root-1" })).ok).toBe(false);
    expect((await removeUnmatchedSignup(client, { actorId: ACTOR, organizationId: ORG, targetId: "nobody" })).ok).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("reports a failed delete and does not claim success", async () => {
    const { client } = make({ deleteError: true });
    const r = await removeUnmatchedSignup(client, { actorId: ACTOR, organizationId: ORG, targetId: "stranger-1" });
    expect(r.ok).toBe(false);
  });
});
