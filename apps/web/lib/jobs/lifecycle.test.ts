import { beforeEach, describe, expect, it, vi } from "vitest";

const adjust = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/quota", async (orig) => ({ ...(await orig<typeof import("@/lib/quota")>()), adjustMonthlyUsage: (...a: unknown[]) => adjust(...a) }));

import { GONE_TO_PRINTER, cancelOwnJob, holdsReservation, isAutoRetryEnabled, requeueFailedJob, retryOwnJob } from "./lifecycle";

type Row = Record<string, unknown>;

/** A tiny stateful stand-in: applies eq/in filters to an in-memory print_jobs table so races/double clicks are real. */
function fakeService(initial: Row, settings: Row | null = null, settingsError = false) {
  const state = { job: { ...initial } as Row, events: [] as Row[], updates: 0 };
  const client = {
    from(table: string) {
      if (table === "print_job_events") return { insert: async (v: Row) => (state.events.push(v), { error: null }) };
      if (table === "organization_settings") {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => (settingsError ? { data: null, error: { message: "column does not exist" } } : { data: settings, error: null }),
        };
        return q;
      }
      let patch: Row | null = null;
      let selecting = false;
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const q: Record<string, unknown> = {
        // Reads return the current row (or none when the filters do not match), like PostgREST.
        select: () => ((selecting = true), q),
        update: (p: Row) => ((patch = p), q),
        eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
        in: (k: string, v: unknown[]) => (ins.push([k, v]), q),
        maybeSingle: async () => {
          const ok = eqs.every(([k, v]) => state.job[k] === v);
          return { data: ok ? { ...state.job } : null, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          const matches = eqs.every(([k, v]) => state.job[k] === v) && ins.every(([k, v]) => v.includes(state.job[k]));
          if (matches && patch) {
            state.job = { ...state.job, ...patch };
            state.updates += 1;
          }
          void selecting;
          resolve({ data: matches ? [{ id: state.job.id }] : [], error: null });
        },
      };
      return q;
    },
  };
  return { client: client as never, state };
}

const base = (over: Row = {}): Row => ({
  id: "j1", organization_id: "org1", created_by: "u1", status: "approved", attempt_count: 0, max_attempts: 3, is_test_print: false,
  source_pdf_pages: 3, copies: 2, estimated_printed_sides: 6, estimated_physical_sheets: 3, color_mode: "bw", files_purged_at: null,
  lease_owner_agent_id: null, lease_expires_at: null, ...over,
});
const ids = { jobId: "j1", userId: "u1", organizationId: "org1" };

beforeEach(() => adjust.mockClear());

describe("holdsReservation", () => {
  it("is true for pending, approved and a failed job with attempts left; false otherwise", () => {
    expect(holdsReservation({ status: "pending_approval", attempt_count: 0, max_attempts: 3, is_test_print: false })).toBe(true);
    expect(holdsReservation({ status: "approved", attempt_count: 0, max_attempts: 3, is_test_print: false })).toBe(true);
    expect(holdsReservation({ status: "failed", attempt_count: 1, max_attempts: 3, is_test_print: false })).toBe(true);
    expect(holdsReservation({ status: "failed", attempt_count: 3, max_attempts: 3, is_test_print: false })).toBe(false);
    expect(holdsReservation({ status: "held", attempt_count: 0, max_attempts: 3, is_test_print: false })).toBe(false);
    expect(holdsReservation({ status: "approved", attempt_count: 0, max_attempts: 3, is_test_print: true })).toBe(false);
  });
});

describe("cancelOwnJob", () => {
  for (const status of ["pending_approval", "approved"]) {
    it(`cancels a ${status} job, releases the reservation once and logs an event`, async () => {
      const f = fakeService(base({ status }));
      expect(await cancelOwnJob(f.client, ids)).toMatchObject({ ok: true });
      expect(f.state.job.status).toBe("cancelled");
      expect(adjust).toHaveBeenCalledTimes(1);
      expect(adjust.mock.calls[0]![5]).toBe("release");
      expect(f.state.events).toHaveLength(1);
      expect(f.state.events[0]).toMatchObject({ event_type: "JOB_CANCELLED", actor_type: "user", actor_id: "u1" });
    });
  }

  it("cancels a held job without touching quota (held reserves nothing)", async () => {
    const f = fakeService(base({ status: "held" }));
    expect(await cancelOwnJob(f.client, ids)).toMatchObject({ ok: true });
    expect(f.state.job.status).toBe("cancelled");
    expect(adjust).not.toHaveBeenCalled();
  });

  it("cancels a retryable failed job and releases; an exhausted failed job is cancelled without a second release", async () => {
    const a = fakeService(base({ status: "failed", attempt_count: 1 }));
    expect(await cancelOwnJob(a.client, ids)).toMatchObject({ ok: true });
    expect(adjust).toHaveBeenCalledTimes(1);
    adjust.mockClear();
    const b = fakeService(base({ status: "failed", attempt_count: 3 }));
    expect(await cancelOwnJob(b.client, ids)).toMatchObject({ ok: true });
    expect(adjust).not.toHaveBeenCalled();
  });

  it("does not release for a test print", async () => {
    const f = fakeService(base({ is_test_print: true }));
    await cancelOwnJob(f.client, ids);
    expect(adjust).not.toHaveBeenCalled();
  });

  for (const status of ["claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"]) {
    it(`refuses honestly once the job is ${status}`, async () => {
      const f = fakeService(base({ status }));
      expect(await cancelOwnJob(f.client, ids)).toEqual({ ok: false, error: GONE_TO_PRINTER });
      expect(f.state.job.status).toBe(status);
      expect(adjust).not.toHaveBeenCalled();
      expect(f.state.events).toHaveLength(0);
    });
  }

  for (const status of ["completed", "rejected", "expired", "denied"]) {
    it(`refuses a ${status} job without writing`, async () => {
      const f = fakeService(base({ status }));
      const r = await cancelOwnJob(f.client, ids);
      expect(r.ok).toBe(false);
      expect(f.state.updates).toBe(0);
      expect(adjust).not.toHaveBeenCalled();
    });
  }

  it("only the owner can cancel: someone else's job (or another org's) is 'not found' and untouched", async () => {
    const f = fakeService(base());
    expect(await cancelOwnJob(f.client, { ...ids, userId: "intruder" })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) });
    expect(await cancelOwnJob(f.client, { ...ids, organizationId: "org2" })).toMatchObject({ ok: false });
    expect(f.state.job.status).toBe("approved");
    expect(adjust).not.toHaveBeenCalled();
  });

  it("a double click releases exactly once", async () => {
    const f = fakeService(base());
    const [a, b] = await Promise.all([cancelOwnJob(f.client, ids), cancelOwnJob(f.client, ids)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(f.state.events).toHaveLength(1);
    const again = await cancelOwnJob(f.client, ids);
    expect(again.ok).toBe(true); // already cancelled: calm and idempotent
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(f.state.events).toHaveLength(1);
  });

  it("loses a race with the agent claiming it: says it went to the printer, releases nothing", async () => {
    const f = fakeService(base());
    const c = f.client as unknown as { from: (t: string) => Record<string, unknown> };
    const realFrom = c.from.bind(c);
    let first = true;
    c.from = (t: string) => {
      const q = realFrom(t);
      if (t === "print_jobs" && typeof q.update === "function") {
        const origUpdate = q.update as (p: Row) => unknown;
        q.update = (p: Row) => {
          if (first) {
            first = false;
            f.state.job.status = "claimed"; // the agent got there between our read and our write
          }
          return origUpdate(p);
        };
      }
      return q;
    };
    const r = await cancelOwnJob(f.client, ids);
    expect(r).toEqual({ ok: false, error: GONE_TO_PRINTER });
    expect(adjust).not.toHaveBeenCalled();
  });
});

describe("retryOwnJob", () => {
  it("re-queues a failed job (failed -> approved), clears the lease, keeps the reservation, logs an event", async () => {
    const f = fakeService(base({ status: "failed", attempt_count: 1, error_message: "x", lease_owner_agent_id: "a1", lease_expires_at: "2026-01-01" }));
    expect(await retryOwnJob(f.client, ids)).toMatchObject({ ok: true });
    expect(f.state.job).toMatchObject({ status: "approved", lease_owner_agent_id: null, lease_expires_at: null, attempt_count: 1 });
    expect(adjust).not.toHaveBeenCalled(); // never double-reserves, never releases
    expect(f.state.events[0]).toMatchObject({ event_type: "RETRY_SCHEDULED", actor_type: "user" });
  });

  it("respects max_attempts", async () => {
    const f = fakeService(base({ status: "failed", attempt_count: 3 }));
    const r = await retryOwnJob(f.client, ids);
    expect(r.ok).toBe(false);
    expect(f.state.job.status).toBe("failed");
  });

  it("refuses non-failed jobs, other users, and a job whose file was purged", async () => {
    expect((await retryOwnJob(fakeService(base({ status: "printing" })).client, ids)).ok).toBe(false);
    expect((await retryOwnJob(fakeService(base({ status: "failed", attempt_count: 1 })).client, { ...ids, userId: "other" })).ok).toBe(false);
    const purged = fakeService(base({ status: "failed", attempt_count: 1, files_purged_at: "2026-01-01" }));
    expect((await retryOwnJob(purged.client, ids)).ok).toBe(false);
    expect(purged.state.job.status).toBe("failed");
  });

  it("a double click queues once", async () => {
    const f = fakeService(base({ status: "failed", attempt_count: 1 }));
    await Promise.all([retryOwnJob(f.client, ids), retryOwnJob(f.client, ids)]);
    expect(f.state.events.filter((e) => e.event_type === "RETRY_SCHEDULED")).toHaveLength(1);
  });
});

describe("requeueFailedJob (automatic retry)", () => {
  it("re-queues only while attempts remain", async () => {
    const f = fakeService(base({ status: "failed", attempt_count: 1 }));
    expect(await requeueFailedJob(f.client, f.state.job as never, { type: "system" })).toBe(true);
    expect(f.state.job.status).toBe("approved");
    expect(f.state.events[0]).toMatchObject({ event_type: "RETRY_SCHEDULED", actor_type: "system" });
    const g = fakeService(base({ status: "failed", attempt_count: 3 }));
    expect(await requeueFailedJob(g.client, g.state.job as never, { type: "system" })).toBe(false);
    expect(g.state.job.status).toBe("failed");
  });
});

describe("isAutoRetryEnabled", () => {
  it("defaults OFF; on only when the setting is true; tolerates the column/table read failing", async () => {
    expect(await isAutoRetryEnabled(fakeService(base(), { auto_retry_failed_prints: true }).client, "org1")).toBe(true);
    expect(await isAutoRetryEnabled(fakeService(base(), { auto_retry_failed_prints: false }).client, "org1")).toBe(false);
    expect(await isAutoRetryEnabled(fakeService(base(), {}).client, "org1")).toBe(false); // column absent
    expect(await isAutoRetryEnabled(fakeService(base(), null).client, "org1")).toBe(false);
    expect(await isAutoRetryEnabled(fakeService(base(), null, true).client, "org1")).toBe(false);
  });
});
