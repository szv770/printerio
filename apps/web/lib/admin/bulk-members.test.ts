import { describe, expect, it } from "vitest";
import { BULK_MAX_IDS, BULK_PRIVILEGED_ROLE_MAX, bulkAuditRow, chunk, normalizeBulkIds, parseBulkOp, planBulkChange, type BulkMemberRow } from "./bulk-members";

const m = (id: string, over: Partial<BulkMemberRow> = {}): BulkMemberRow => ({ userId: id, role: "student", status: "active", department: null, ...over });
const base = { actorId: "me", activeAdminCount: 3 };

describe("normalizeBulkIds", () => {
  it("dedupes and refuses junk, empty and too many", () => {
    expect(normalizeBulkIds(["a", "a", "b"])).toEqual({ ok: true, ids: ["a", "b"] });
    expect(normalizeBulkIds([])).toMatchObject({ ok: false });
    expect(normalizeBulkIds("a")).toMatchObject({ ok: false });
    expect(normalizeBulkIds(["a", { $ne: 1 }])).toMatchObject({ ok: false });
    expect(normalizeBulkIds(["a,b"])).toMatchObject({ ok: false });
    expect(normalizeBulkIds(Array.from({ length: BULK_MAX_IDS + 1 }, (_, i) => `u${i}`))).toMatchObject({ ok: false });
  });
});

describe("parseBulkOp", () => {
  it("validates", () => {
    expect(parseBulkOp({ type: "role", role: "root" })).toMatchObject({ ok: false });
    expect(parseBulkOp({ type: "section", section: "  Art " })).toEqual({ ok: true, op: { type: "section", section: "Art" } });
    expect(parseBulkOp({ type: "section", section: "x".repeat(81) })).toMatchObject({ ok: false });
    expect(parseBulkOp({ type: "status", status: "gone" })).toMatchObject({ ok: false });
    expect(parseBulkOp(null)).toMatchObject({ ok: false });
  });
});

describe("planBulkChange", () => {
  it("refuses the whole request if any id is not in the organization (cross-org ids)", () => {
    const plan = planBulkChange({ ...base, op: { type: "section", section: "Art" }, requestedIds: ["a", "foreign"], found: [m("a")] });
    expect(plan.ok).toBe(false);
  });
  it("only changes people who actually differ", () => {
    const plan = planBulkChange({ ...base, op: { type: "section", section: "Art" }, requestedIds: ["a", "b"], found: [m("a"), m("b", { department: "Art" })] });
    expect(plan).toMatchObject({ ok: true, changing: ["a"], unchanged: 1 });
  });
  it("blocks taking the last admin away by demote, switch off or remove", () => {
    const found = [m("a", { role: "org_admin" })];
    const one = { actorId: "me", activeAdminCount: 1, requestedIds: ["a"], found };
    expect(planBulkChange({ ...one, op: { type: "role", role: "staff" } })).toMatchObject({ ok: false });
    expect(planBulkChange({ ...one, op: { type: "status", status: "disabled" } })).toMatchObject({ ok: false });
    expect(planBulkChange({ ...one, op: { type: "remove" } })).toMatchObject({ ok: false });
  });
  it("allows it while another active admin remains, and counts all admins in the batch", () => {
    const found = [m("a", { role: "org_admin" }), m("b", { role: "org_admin" })];
    expect(planBulkChange({ actorId: "me", activeAdminCount: 3, op: { type: "remove" }, requestedIds: ["a", "b"], found })).toMatchObject({ ok: true, lostAdmins: 2 });
    expect(planBulkChange({ actorId: "me", activeAdminCount: 2, op: { type: "remove" }, requestedIds: ["a", "b"], found })).toMatchObject({ ok: false });
  });
  it("never lets you switch off, remove or demote yourself in bulk", () => {
    const found = [m("me", { role: "org_admin" }), m("b")];
    const args = { actorId: "me", activeAdminCount: 5, requestedIds: ["me", "b"], found };
    expect(planBulkChange({ ...args, op: { type: "status", status: "disabled" } })).toMatchObject({ ok: false });
    expect(planBulkChange({ ...args, op: { type: "remove" } })).toMatchObject({ ok: false });
    expect(planBulkChange({ ...args, op: { type: "role", role: "staff" } })).toMatchObject({ ok: false });
    expect(planBulkChange({ ...args, op: { type: "status", status: "active" } })).toMatchObject({ ok: true });
  });
  it("needs a confirm to give approver or admin rights, and caps how many", () => {
    const found = [m("a"), m("b")];
    const args = { ...base, requestedIds: ["a", "b"], found };
    expect(planBulkChange({ ...args, op: { type: "role", role: "approver" } })).toMatchObject({ ok: false, needsConfirm: "privileged_role" });
    expect(planBulkChange({ ...args, op: { type: "role", role: "approver", confirmPrivileged: true } })).toMatchObject({ ok: true, changing: ["a", "b"] });
    expect(planBulkChange({ ...args, op: { type: "role", role: "staff" } })).toMatchObject({ ok: true });
    const many = Array.from({ length: BULK_PRIVILEGED_ROLE_MAX + 1 }, (_, i) => m(`u${i}`));
    expect(planBulkChange({ ...base, requestedIds: many.map((x) => x.userId), found: many, op: { type: "role", role: "org_admin", confirmPrivileged: true } })).toMatchObject({ ok: false });
  });
});

describe("audit and chunks", () => {
  it("one row with count, patch and a sample of ids (no more than 10)", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `u${i}`);
    const row = bulkAuditRow({ organizationId: "o", actorId: "me", op: { type: "role", role: "staff" }, changedIds: ids, unchanged: 2 });
    expect(row).toMatchObject({ organization_id: "o", actor_id: "me", action: "members.bulk_role_changed", target_id: null });
    expect(row.metadata).toMatchObject({ count: 30, unchanged: 2, role: "staff" });
    expect(row.metadata.sample_ids).toHaveLength(10);
  });
  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
