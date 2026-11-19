import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => ({ userId: "admin-1", membership: { organization_id: "org-1", role: "org_admin" } }),
}));
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));
vi.mock("@/lib/jobs/lifecycle", () => ({ cancelMemberQueue: async () => ({ cancelled: 0, skipped: 0, more: false }) }));

import { bulkUpdateMembersAction } from "./bulk-actions";

type Row = { user_id: string; role: string; status: string; department: string | null };
const row = (id: string, over: Partial<Row> = {}): Row => ({ user_id: id, role: "student", status: "active", department: null, ...over });

/** `inOrg` = the members that exist in org-1; `admins` = the active admin count. */
function setup(inOrg: Row[], admins = 2, failUpdate = false) {
  fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "organization_members" && c.op === "select") {
      if (c.columns === "user_id" ) return { data: null, error: null, count: admins };
      const idsFilter = c.filters.find((f) => f[0] === "in");
      const wanted = (idsFilter?.[2] as string[]) ?? [];
      return ok(inOrg.filter((r) => wanted.includes(r.user_id)));
    }
    if (c.table === "organization_members" && c.op === "update" && failUpdate) return { data: null, error: { message: "boom" } };
    return ok();
  });
}
const writes = (op: string) => fake.calls.filter((c) => c.table === "organization_members" && c.op === op);
const audits = () => fake.calls.filter((c) => c.table === "audit_logs");

beforeEach(() => setup([row("a"), row("b")]));

describe("bulkUpdateMembersAction", () => {
  it("changes sections in one scoped statement and writes ONE audit row", async () => {
    const res = await bulkUpdateMembersAction({ ids: ["a", "b"], op: { type: "section", section: "Art" }, confirmCount: 2 });
    expect(res).toMatchObject({ ok: true, changed: 2 });
    expect(writes("update")).toHaveLength(1);
    expect(writes("update")[0]!.values).toEqual({ department: "Art" });
    expect(writes("update")[0]!.filters).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(audits()).toHaveLength(1);
    expect((audits()[0]!.values as { action: string }).action).toBe("members.bulk_section_changed");
  });
  it("rejects ids that are not in the admin's organization and writes nothing", async () => {
    const res = await bulkUpdateMembersAction({ ids: ["a", "other-org-user"], op: { type: "status", status: "disabled" }, confirmCount: 2 });
    expect(res.ok).toBe(false);
    expect(writes("update")).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
  it("looks every id up with the organization filter", async () => {
    await bulkUpdateMembersAction({ ids: ["a"], op: { type: "section", section: null }, confirmCount: 1 });
    const lookup = fake.calls.find((c) => c.table === "organization_members" && c.op === "select")!;
    expect(lookup.filters).toContainEqual(["eq", "organization_id", "org-1"]);
  });
  it("refuses when the confirmed count is not the list size", async () => {
    const res = await bulkUpdateMembersAction({ ids: ["a", "b"], op: { type: "remove" }, confirmCount: 1 });
    expect(res.ok).toBe(false);
    expect(writes("delete")).toHaveLength(0);
  });
  it("keeps the last admin", async () => {
    setup([row("a", { role: "org_admin" })], 1);
    const res = await bulkUpdateMembersAction({ ids: ["a"], op: { type: "role", role: "staff" }, confirmCount: 1 });
    expect(res.ok).toBe(false);
    expect(writes("update")).toHaveLength(0);
  });
  it("asks for a confirm before giving approver rights", async () => {
    const res = await bulkUpdateMembersAction({ ids: ["a", "b"], op: { type: "role", role: "approver" }, confirmCount: 2 });
    expect(res).toMatchObject({ ok: false, needsConfirm: "privileged_role" });
    expect(writes("update")).toHaveLength(0);
    const again = await bulkUpdateMembersAction({ ids: ["a", "b"], op: { type: "role", role: "approver", confirmPrivileged: true }, confirmCount: 2 });
    expect(again.ok).toBe(true);
    expect(audits()).toHaveLength(1);
  });
  it("caps the batch and refuses junk ids", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `u${i}`);
    expect((await bulkUpdateMembersAction({ ids: many, op: { type: "remove" }, confirmCount: 201 })).ok).toBe(false);
    expect((await bulkUpdateMembersAction({ ids: [{}], op: { type: "remove" }, confirmCount: 1 })).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
  it("remove deletes with the organization filter, clears group memberships and audits once", async () => {
    const res = await bulkUpdateMembersAction({ ids: ["a", "b"], op: { type: "remove" }, confirmCount: 2 });
    expect(res.ok).toBe(true);
    expect(writes("delete")[0]!.filters).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(fake.calls.some((c) => c.table === "group_members" || c.table === "groups")).toBe(true);
    expect(audits()).toHaveLength(1);
  });
  it("reports a failed save plainly and writes no audit row for nothing changed", async () => {
    setup([row("a")], 2, true);
    const res = await bulkUpdateMembersAction({ ids: ["a"], op: { type: "section", section: "Art" }, confirmCount: 1 });
    expect(res.ok).toBe(false);
    expect(audits()).toHaveLength(0);
  });
});
