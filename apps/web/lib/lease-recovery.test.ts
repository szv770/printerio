import { beforeEach, describe, expect, it, vi } from "vitest";

const adjust = vi.fn(async () => true);
vi.mock("@/lib/quota", async (orig) => ({ ...(await orig<typeof import("@/lib/quota")>()), adjustMonthlyUsage: (...a: unknown[]) => (adjust as (...x: unknown[]) => unknown)(...a) }));
const isAutoRetryEnabled = vi.fn(async () => false);
const requeueFailedJob = vi.fn(async () => true);
vi.mock("@/lib/jobs/lifecycle", () => ({
  isAutoRetryEnabled: (...a: unknown[]) => (isAutoRetryEnabled as (...x: unknown[]) => unknown)(...a),
  requeueFailedJob: (...a: unknown[]) => (requeueFailedJob as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { recoverExpiredLeases, recoverExpiredLeasesForAgent, resetLeaseRecoveryThrottle, OPPORTUNISTIC_GRACE_MS, OPPORTUNISTIC_MIN_INTERVAL_MS } from "./lease-recovery";

type Row = Record<string, unknown>;
let jobs: Row[];
let events: Row[];
let selectLimits: number[];

/** Tiny in-memory PostgREST: applies eq/in/lt filters for real, so a missing scope filter shows up as a wrong result. */
function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" = "select";
  let patch: Row = {};
  let inserted: Row[] = [];
  let limit: number | null = null;
  const q: Record<string, unknown> = {
    select: () => q,
    update: (p: Row) => ((mode = "update"), (patch = p), q),
    insert: (rows: Row | Row[]) => ((mode = "insert"), (inserted = Array.isArray(rows) ? rows : [rows]), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
    lt: (k: string, v: string) => (filters.push((r) => r[k] != null && Date.parse(r[k] as string) < Date.parse(v)), q),
    order: () => q,
    limit: (n: number) => ((limit = n), selectLimits.push(n), q),
    then: (resolve: (v: unknown) => void) => {
      if (table === "print_job_events") {
        if (mode === "insert") events.push(...inserted);
        return resolve({ data: null, error: null });
      }
      let matched = jobs.filter((r) => filters.every((f) => f(r)));
      if (limit !== null) matched = matched.slice(0, limit);
      if (mode === "update") {
        for (const r of matched) Object.assign(r, patch);
        return resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
      }
      resolve({ data: matched.map((r) => ({ ...r })), error: null });
    },
  };
  return q;
}
const supabase = { from: (t: string) => builder(t) } as never;

const NOW = new Date("2026-10-23T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const job = (id: string, over: Row = {}): Row => ({
  id, organization_id: "org1", printer_profile_id: "prof1", created_by: "u1", status: "printing",
  lease_expires_at: minutesAgo(30), attempt_count: 0, max_attempts: 1, is_test_print: false,
  source_pdf_pages: 2, copies: 1, estimated_printed_sides: 2, estimated_physical_sheets: 1, color_mode: "bw", ...over,
});

beforeEach(() => {
  resetLeaseRecoveryThrottle();
  jobs = [];
  events = [];
  selectLimits = [];
  adjust.mockClear();
  isAutoRetryEnabled.mockReset().mockResolvedValue(false);
  requeueFailedJob.mockReset().mockResolvedValue(true);
});

describe("recoverExpiredLeases (shared by the sweep and the claimable poll)", () => {
  it("returns an expired 'claimed' job to the pool and writes a LEASE_EXPIRED event, without touching quota", async () => {
    jobs = [job("a", { status: "claimed", lease_owner_agent_id: "agent1" })];
    const r = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(r.releasedLeases).toBe(1);
    expect(jobs[0]).toMatchObject({ status: "approved", lease_owner_agent_id: null, lease_expires_at: null });
    expect(events).toHaveLength(1);
    expect(adjust).not.toHaveBeenCalled();
  });

  it("fails an expired mid-flight job, bumps attempt_count and releases quota once when attempts are exhausted", async () => {
    jobs = [job("a", { status: "printing" })];
    const r = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(r.failedFromStaleLease).toBe(1);
    expect(jobs[0]).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(adjust).toHaveBeenCalledTimes(1);
    expect((adjust.mock.calls[0] as unknown[])[5]).toBe("release");
  });

  it("does NOT release quota while retries remain (reservation is kept for Try again)", async () => {
    jobs = [job("a", { max_attempts: 3 })];
    await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(jobs[0]).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(adjust).not.toHaveBeenCalled();
  });

  it("never releases quota for a test print (it never reserved any)", async () => {
    jobs = [job("a", { is_test_print: true })];
    await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(jobs[0]!.status).toBe("failed");
    expect(adjust).not.toHaveBeenCalled();
  });

  it("is idempotent: running it twice (sweep + poll in the same second) releases quota exactly once", async () => {
    jobs = [job("a"), job("b", { created_by: "u1" })];
    const first = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    const second = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(first.failedFromStaleLease).toBe(2);
    expect(second.failedFromStaleLease).toBe(0);
    expect(adjust).toHaveBeenCalledTimes(1); // one batched call for the single (org,user) group
    expect(events).toHaveLength(2);
    expect(jobs.every((j) => j.attempt_count === 1)).toBe(true);
  });

  it("two concurrent runs that both selected the same job: only the one whose conditional UPDATE matched releases quota", async () => {
    jobs = [job("a")];
    const [x, y] = await Promise.all([
      recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 }),
      recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 }),
    ]);
    expect(x.failedFromStaleLease + y.failedFromStaleLease).toBe(1);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(jobs[0]!.attempt_count).toBe(1);
  });

  it("leaves jobs whose lease has not expired alone", async () => {
    jobs = [job("a", { lease_expires_at: new Date(NOW.getTime() + 60_000).toISOString() }), job("b", { status: "claimed", lease_expires_at: null })];
    const r = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(r).toEqual({ releasedLeases: 0, failedFromStaleLease: 0, autoRetried: 0 });
    expect(jobs[0]!.status).toBe("printing");
  });

  it("auto-retries (re-queues) only when the org enabled it and attempts remain", async () => {
    jobs = [job("a", { max_attempts: 3 })];
    isAutoRetryEnabled.mockResolvedValue(true);
    const r = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 50 });
    expect(r.autoRetried).toBe(1);
    expect(requeueFailedJob).toHaveBeenCalledTimes(1);
  });

  it("honours the per-query limit", async () => {
    jobs = Array.from({ length: 5 }, (_, i) => job(`j${i}`));
    const r = await recoverExpiredLeases(supabase, { nowIso: NOW.toISOString(), limit: 2 });
    expect(r.failedFromStaleLease).toBe(2);
    expect(Math.max(...selectLimits)).toBe(2);
  });
});

describe("recoverExpiredLeasesForAgent (the claimable poll)", () => {
  const scope = { organizationId: "org1", agentId: "agent1", printerProfileIds: ["prof1"] };

  it("only touches this organization's jobs on this agent's printer profiles", async () => {
    jobs = [
      job("mine"),
      job("other-org", { organization_id: "org2" }),
      job("other-profile", { printer_profile_id: "prof9" }),
      job("claimed-mine", { status: "claimed" }),
    ];
    const r = await recoverExpiredLeasesForAgent(supabase, scope, NOW);
    expect(r).toMatchObject({ failedFromStaleLease: 1, releasedLeases: 1 });
    expect(jobs.find((j) => j.id === "other-org")!.status).toBe("printing");
    expect(jobs.find((j) => j.id === "other-profile")!.status).toBe("printing");
  });

  it("is bounded to 50 rows per query", async () => {
    jobs = [job("a")];
    await recoverExpiredLeasesForAgent(supabase, scope, NOW);
    expect(Math.max(...selectLimits)).toBe(50);
  });

  it("gives a lease a grace period past expiry, so a slow-but-alive print is not failed under the agent", async () => {
    jobs = [job("fresh", { lease_expires_at: new Date(NOW.getTime() - OPPORTUNISTIC_GRACE_MS + 10_000).toISOString() })];
    const r = await recoverExpiredLeasesForAgent(supabase, scope, NOW);
    expect(r?.failedFromStaleLease).toBe(0);
    expect(jobs[0]!.status).toBe("printing");
  });

  it("runs at most once per interval per agent, then again after it; other agents are not throttled", async () => {
    jobs = [job("a")];
    expect(await recoverExpiredLeasesForAgent(supabase, scope, NOW)).not.toBeNull();
    const queriesAfterFirst = selectLimits.length;
    expect(await recoverExpiredLeasesForAgent(supabase, scope, new Date(NOW.getTime() + 60_000))).toBeNull();
    expect(selectLimits.length).toBe(queriesAfterFirst); // no queries at all while throttled
    expect(await recoverExpiredLeasesForAgent(supabase, { ...scope, agentId: "agent2" }, new Date(NOW.getTime() + 60_000))).not.toBeNull();
    expect(await recoverExpiredLeasesForAgent(supabase, scope, new Date(NOW.getTime() + OPPORTUNISTIC_MIN_INTERVAL_MS + 1))).not.toBeNull();
  });

  it("does nothing for an agent with no printer profiles", async () => {
    jobs = [job("a")];
    const r = await recoverExpiredLeasesForAgent(supabase, { ...scope, printerProfileIds: [] }, NOW);
    expect(r?.failedFromStaleLease).toBe(0);
    expect(jobs[0]!.status).toBe("printing");
  });

  it("never throws: a database failure is swallowed and reported as null", async () => {
    const broken = {
      from: () => {
        throw new Error("db down");
      },
    } as never;
    await expect(recoverExpiredLeasesForAgent(broken, scope, NOW)).resolves.toBeNull();
  });
});
