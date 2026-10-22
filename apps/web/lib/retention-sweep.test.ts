import { describe, expect, it } from "vitest";
import { purgeJobFiles, sweepRetention } from "./retention";

const NOW = new Date("2026-10-25T03:00:00Z");

/** Records every query the sweep builds so the eligibility rules can be asserted. */
function fake() {
  const calls: { table: string; op: string; args: Record<string, unknown> }[] = [];
  const removed: string[][] = [];
  const client = {
    storage: { from: () => ({ remove: async (p: string[]) => (removed.push(p), { error: null }) }) },
    from: (table: string) => {
      const rec = { table, op: "select", args: {} as Record<string, unknown> };
      calls.push(rec);
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "in", "lt", "not", "is", "order", "limit"]) {
        chain[m] = (...a: unknown[]) => ((rec.args[m] = a), chain);
      }
      chain.update = (v: unknown) => ((rec.op = "update"), (rec.args.update = v), chain);
      chain.delete = () => ((rec.op = "delete"), chain);
      chain.select = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        if (table === "organization_settings") {
          return resolve({
            data: [{ organization_id: "o1", retention_completed_days: 7, retention_rejected_days: 3, retention_failed_days: 7 }],
            error: null,
          });
        }
        if (table === "print_jobs" && rec.op === "select") {
          return resolve({ data: [{ id: "j1", original_file_path: "a/original.pdf", derived_file_path: "a/derived.pdf" }], error: null });
        }
        return resolve({ data: null, error: null });
      };
      return chain;
    },
  };
  return { client: client as never, calls, removed };
}

describe("sweepRetention", () => {
  it("selects only finished statuses older than the window, unpurged, within the limit", async () => {
    const f = fake();
    await sweepRetention(f.client, { now: NOW, limit: 25 });
    const selects = f.calls.filter((c) => c.table === "print_jobs" && c.op === "select");
    expect(selects).toHaveLength(3);
    const allStatuses = selects.flatMap((s) => (s.args.in as [string, string[]])[1]);
    expect(allStatuses.sort()).toEqual(["cancelled", "completed", "denied", "expired", "failed", "rejected"]);
    for (const banned of ["held", "pending_approval", "approved", "queued", "printing", "claimed"]) {
      expect(allStatuses).not.toContain(banned);
    }
    expect(selects[0]!.args.limit).toEqual([25]);
    expect(selects[0]!.args.is).toEqual(["files_purged_at", null]);
    // completed window = 7 days
    expect(selects[0]!.args.lt).toEqual(["updated_at", "2026-10-18T03:00:00.000Z"]);
  });

  it("removes original and derived, then stamps files_purged_at and never deletes a row", async () => {
    const f = fake();
    const r = await sweepRetention(f.client, { now: NOW, limit: 25 });
    expect(f.removed[0]).toEqual(["a/original.pdf", "a/derived.pdf"]);
    const updates = f.calls.filter((c) => c.op === "update");
    expect(updates[0]!.args.update).toEqual({ files_purged_at: NOW.toISOString() });
    expect(f.calls.some((c) => c.table === "print_jobs" && c.op === "delete")).toBe(false);
    expect(r.jobsPurged).toBe(3);
  });
});

describe("purgeJobFiles", () => {
  it("does nothing for a job with no stored paths", async () => {
    const f = fake();
    const r = await purgeJobFiles(f.client, [{ id: "x", original_file_path: null, derived_file_path: null }], NOW.toISOString());
    expect(r).toEqual({ filesDeleted: 0, jobsPurged: 0 });
    expect(f.removed).toHaveLength(0);
  });
});
