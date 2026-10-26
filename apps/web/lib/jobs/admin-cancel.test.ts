import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const adjust = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/quota", async (orig) => ({ ...(await orig<typeof import("@/lib/quota")>()), adjustMonthlyUsage: (...a: unknown[]) => adjust(...a) }));

import { cancelJobAsAdmin, cancelMemberQueue, GONE_TO_PRINTER } from "./lifecycle";

type Row = Record<string, unknown>;

/** A small in-memory print_jobs table that applies eq / in / limit like PostgREST, so each cancel really is conditional. */
function fakeService(rows: Row[]) {
  const state = { jobs: rows.map((r) => ({ ...r })), events: [] as Row[] };
  const client = {
    from(table: string) {
      if (table === "print_job_events") return { insert: async (v: Row) => (state.events.push(v), { error: null }) };
      let patch: Row | null = null;
      let max = Infinity;
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const matching = () => state.jobs.filter((j) => eqs.every(([k, v]) => j[k] === v) && ins.every(([k, v]) => v.includes(j[k])));
      const q: Record<string, unknown> = {
        select: () => q,
        update: (p: Row) => ((patch = p), q),
        eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
        in: (k: string, v: unknown[]) => (ins.push([k, v]), q),
        limit: (n: number) => ((max = n), q),
        maybeSingle: async () => ({ data: matching()[0] ? { ...matching()[0] } : null, error: null }),
        then: (resolve: (v: unknown) => void) => {
          const hit = matching().slice(0, max);
          if (patch) for (const j of hit) Object.assign(j, patch);
          resolve({ data: hit.map((j) => ({ id: j.id })), error: null });
        },
      };
      return q;
    },
  };
  return { client: client as never, state };
}

const job = (over: Row = {}): Row => ({
  id: "j1", organization_id: "org1", created_by: "u1", status: "approved", attempt_count: 0, max_attempts: 3, is_test_print: false,
  source_pdf_pages: 3, copies: 2, estimated_printed_sides: 6, estimated_physical_sheets: 3, color_mode: "bw", files_purged_at: null, ...over,
});
const ref = { jobId: "j1", organizationId: "org1", adminId: "admin1" };

beforeEach(() => adjust.mockClear());

describe("cancelJobAsAdmin", () => {
  it("cancels someone else's waiting job, records the admin, and releases that person's quota once", async () => {
    const { client, state } = fakeService([job()]);
    expect(await cancelJobAsAdmin(client, ref)).toMatchObject({ ok: true });
    expect(state.jobs[0]!.status).toBe("cancelled");
    expect(state.events[0]).toMatchObject({ job_id: "j1", event_type: "JOB_CANCELLED", actor_type: "admin", actor_id: "admin1" });
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust.mock.calls[0]![1]).toMatchObject({ organizationId: "org1", userId: "u1" });
    // a second press changes nothing and does not release twice
    expect(await cancelJobAsAdmin(client, ref)).toMatchObject({ ok: true });
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  it("cancels any job that has not started printing: waiting, held, or picked up by the print program, and releases the quota only where one was held", async () => {
    for (const status of ["pending_approval", "claimed", "downloading", "downloaded"]) {
      adjust.mockClear();
      const { client, state } = fakeService([job({ status })]);
      expect((await cancelJobAsAdmin(client, ref)).ok, status).toBe(true);
      expect(state.jobs[0]!.status).toBe("cancelled");
      expect(adjust, status).toHaveBeenCalledTimes(1);
    }
    adjust.mockClear();
    const held = fakeService([job({ status: "held" })]);
    expect((await cancelJobAsAdmin(held.client, ref)).ok).toBe(true);
    expect(adjust).not.toHaveBeenCalled(); // a held job never reserved anything
  });

  it("refuses a job that is already printing or finished (it cannot be recalled from the printer)", async () => {
    for (const status of ["printing", "submitted_to_spooler"]) {
      const { client, state } = fakeService([job({ status })]);
      expect(await cancelJobAsAdmin(client, ref)).toEqual({ ok: false, error: GONE_TO_PRINTER });
      expect(state.jobs[0]!.status).toBe(status);
    }
    const done = fakeService([job({ status: "completed" })]);
    expect((await cancelJobAsAdmin(done.client, ref)).ok).toBe(false);
  });

  it("never reaches a job in another organization", async () => {
    const { client, state } = fakeService([job({ organization_id: "org2" })]);
    expect(await cancelJobAsAdmin(client, ref)).toEqual({ ok: false, error: "Job not found." });
    expect(state.jobs[0]!.status).toBe("approved");
    expect(adjust).not.toHaveBeenCalled();
  });
});

describe("cancelMemberQueue (stop one person's whole line)", () => {
  const many = (n: number, over: Row = {}) => Array.from({ length: n }, (_, i) => job({ id: `a${i}`, ...over }));

  it("cancels every waiting job of that person and nobody else's, and says how many", async () => {
    const { client, state } = fakeService([...many(3), job({ id: "other", created_by: "u2" }), job({ id: "printing", status: "printing" }), job({ id: "elsewhere", organization_id: "org2" })]);
    const res = await cancelMemberQueue(client, { organizationId: "org1", adminId: "admin1", userId: "u1" });
    expect(res).toEqual({ cancelled: 3, skipped: 0, more: false });
    expect(state.jobs.filter((j) => j.status === "cancelled").map((j) => j.id).sort()).toEqual(["a0", "a1", "a2"]);
    expect(state.jobs.find((j) => j.id === "other")!.status).toBe("approved");
    expect(state.jobs.find((j) => j.id === "printing")!.status).toBe("printing");
    expect(state.jobs.find((j) => j.id === "elsewhere")!.status).toBe("approved");
    expect(adjust).toHaveBeenCalledTimes(3);
  });

  it("works in bounded batches and says when there are more", async () => {
    const { client, state } = fakeService(many(5));
    const res = await cancelMemberQueue(client, { organizationId: "org1", adminId: "admin1", userId: "u1", limit: 3 });
    expect(res).toEqual({ cancelled: 3, skipped: 0, more: true });
    expect(state.jobs.filter((j) => j.status === "cancelled")).toHaveLength(3);
  });

  it("does nothing, harmlessly, for a person with nothing waiting", async () => {
    const { client } = fakeService([]);
    expect(await cancelMemberQueue(client, { organizationId: "org1", adminId: "admin1", userId: "u9" })).toEqual({ cancelled: 0, skipped: 0, more: false });
  });
});
