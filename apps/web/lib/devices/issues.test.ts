import { describe, expect, it } from "vitest";
import { fakeSupabase, failure, ok } from "@/test/fake-supabase";
import { listEventsForDevice, listIssuesForDevices, reportIssue, resolveIssue } from "./devices";

describe("reportIssue", () => {
  it("checks the device belongs to the member, then inserts only the granted columns", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok({ id: "d1" }) : ok(null)));
    const res = await reportIssue(fake.client as never, { deviceId: "d1", userId: "u1", organizationId: "org1", kind: "cant_add", note: "help" });
    expect(res).toEqual({ ok: true });
    const sel = fake.calls.find((c) => c.op === "select")!;
    expect(sel.table).toBe("member_devices");
    expect(sel.filters).toContainEqual(["eq", "user_id", "u1"]);
    expect(sel.filters).toContainEqual(["eq", "organization_id", "org1"]);
    const ins = fake.calls.find((c) => c.op === "insert")!;
    expect(ins.table).toBe("device_issues");
    expect(ins.values).toEqual({ device_id: "d1", kind: "cant_add", note: "help" });
  });
  it("refuses a device that is not theirs and never inserts", async () => {
    const fake = fakeSupabase(() => ok(null));
    const res = await reportIssue(fake.client as never, { deviceId: "x", userId: "u1", organizationId: "org1", kind: "other", note: "" });
    expect(res).toMatchObject({ ok: false });
    expect(fake.calls.some((c) => c.op === "insert")).toBe(false);
  });
  it("refuses invalid input before touching the database", async () => {
    const fake = fakeSupabase(() => ok({ id: "d1" }));
    const res = await reportIssue(fake.client as never, { deviceId: "d1", userId: "u1", organizationId: "o", kind: "nope", note: "" });
    expect(res.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
  it("returns a plain error when the insert fails", async () => {
    const fake = fakeSupabase((c) => (c.op === "select" ? ok({ id: "d1" }) : failure("rls violation")));
    const res = await reportIssue(fake.client as never, { deviceId: "d1", userId: "u1", organizationId: "o", kind: "other", note: "" });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error).not.toMatch(/rls/);
  });
});

describe("resolveIssue", () => {
  it("updates the granted columns, only for open issues", async () => {
    const fake = fakeSupabase(() => ok([{ id: "i1" }]));
    const res = await resolveIssue(fake.client as never, { issueId: "i1", adminId: "a1", organizationId: "org1", note: " fixed " });
    expect(res).toEqual({ ok: true });
    const upd = fake.calls.find((c) => c.op === "update")!;
    expect(upd.table).toBe("device_issues");
    const v = upd.values as Record<string, unknown>;
    expect(v).toMatchObject({ status: "resolved", resolved_by: "a1", resolved_note: "fixed" });
    expect(typeof v.resolved_at).toBe("string");
    expect(upd.filters).toContainEqual(["eq", "id", "i1"]);
    expect(upd.filters).toContainEqual(["eq", "status", "open"]);
  });
  it("says not found when nothing was updated", async () => {
    const fake = fakeSupabase(() => ok([]));
    const res = await resolveIssue(fake.client as never, { issueId: "i1", adminId: "a1", organizationId: "org1", note: "" });
    expect(res).toMatchObject({ ok: false });
  });
  it("rejects an over-long note without a query", async () => {
    const fake = fakeSupabase(() => ok([]));
    const res = await resolveIssue(fake.client as never, { issueId: "i1", adminId: "a1", organizationId: "o", note: "x".repeat(2001) });
    expect(res.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("list helpers", () => {
  it("lists issues for the given devices only, and skips the query for none", async () => {
    const fake = fakeSupabase(() => ok([{ id: "i1", device_id: "d1" }]));
    expect(await listIssuesForDevices(fake.client as never, [])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    const rows = await listIssuesForDevices(fake.client as never, ["d1"]);
    expect(rows).toHaveLength(1);
    expect(fake.calls[0]!.filters).toContainEqual(["in", "device_id", ["d1"]]);
  });
  it("lists the newest events of one device, limited", async () => {
    const fake = fakeSupabase(() => ok([{ id: "e1" }]));
    await listEventsForDevice(fake.client as never, "d1", 30);
    const f = fake.calls[0]!.filters;
    expect(f).toContainEqual(["eq", "device_id", "d1"]);
    expect(f).toContainEqual(["limit", 30]);
  });
});
