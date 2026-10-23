import { beforeEach, describe, expect, it, vi } from "vitest";

let agentRow: { id: string; organizationId: string; paused: boolean } = { id: "agent1", organizationId: "org1", paused: false };
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => agentRow }));

type Row = Record<string, unknown>;
let jobs: Row[];
let lastJobQuery: { orders: Array<[string, unknown]>; limit: number | null; or: string | null; eqs: Array<[string, unknown]> };

/** Applies the same filters PostgREST would, so an ordering/limit bug shows up as wrong output, not only as a wrong call. */
const service = {
  from(table: string) {
    if (table === "printer_profiles") {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: "prof1" }], error: null }),
      };
      return q;
    }
    lastJobQuery = { orders: [], limit: null, or: null, eqs: [] };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => (lastJobQuery.eqs.push([k, v]), q),
      in: () => q,
      or: (expr: string) => ((lastJobQuery.or = expr), q),
      order: (col: string, opts: unknown) => (lastJobQuery.orders.push([col, opts]), q),
      limit: (n: number) => ((lastJobQuery.limit = n), q),
      then: (resolve: (v: unknown) => void) => {
        let rows = jobs.filter((j) => j.status === "approved");
        const m = /lease_expires_at\.lt\.([^,)]+)/.exec(lastJobQuery.or ?? "");
        if (m) rows = rows.filter((j) => j.lease_expires_at == null || Date.parse(j.lease_expires_at as string) < Date.parse(m[1] as string));
        const asc = lastJobQuery.orders.find(([c]) => c === "created_at");
        if (asc) rows = [...rows].sort((a, b) => (Date.parse(a.created_at as string) - Date.parse(b.created_at as string)) * ((asc[1] as { ascending?: boolean })?.ascending === false ? -1 : 1));
        if (lastJobQuery.limit !== null) rows = rows.slice(0, lastJobQuery.limit);
        resolve({ data: rows, error: null });
      },
    };
    return q;
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { GET } from "./route";

const get = () => GET(new Request("http://x"));
const job = (n: number, over: Row = {}): Row => ({
  id: `j${n}`, job_number: `JOB-${n}`, printer_profile_id: "prof1", status: "approved", lease_expires_at: null,
  created_at: new Date(Date.UTC(2026, 9, 23, 8, 0, n)).toISOString(), ...over,
});

beforeEach(() => {
  agentRow = { id: "agent1", organizationId: "org1", paused: false };
});

describe("claimable jobs: fairness", () => {
  it("returns the OLDEST job first, whatever order the database holds them in", async () => {
    jobs = [job(5), job(1), job(3), job(2), job(4)];
    const body = await (await get()).json();
    expect(body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(["j1", "j2", "j3", "j4", "j5"]);
    expect(lastJobQuery.orders[0]).toEqual(["created_at", { ascending: true }]);
  });

  it("is capped at 50 jobs, and the 50 are the oldest ones", async () => {
    jobs = Array.from({ length: 120 }, (_, i) => job(120 - i));
    const body = await (await get()).json();
    expect(body.jobs).toHaveLength(50);
    expect(body.jobs[0].jobId).toBe("j1");
    expect(body.jobs[49].jobId).toBe("j50");
    expect(lastJobQuery.limit).toBe(50);
  });

  it("breaks created_at ties deterministically (second sort key = id)", async () => {
    jobs = [job(1)];
    await get();
    expect(lastJobQuery.orders.map(([c]) => c)).toEqual(["created_at", "id"]);
  });

  it("hides a job that is waiting out its backoff, and offers it again once the backoff has passed", async () => {
    jobs = [
      job(1, { lease_expires_at: new Date(Date.now() + 60_000).toISOString() }),
      job(2),
      job(3, { lease_expires_at: new Date(Date.now() - 1_000).toISOString() }),
    ];
    const ids = (await (await get()).json()).jobs.map((j: { jobId: string }) => j.jobId);
    expect(ids).toEqual(["j2", "j3"]);
  });

  it("a paused agent is offered nothing", async () => {
    agentRow = { id: "agent1", organizationId: "org1", paused: true };
    jobs = [job(1)];
    expect((await (await get()).json()).jobs).toEqual([]);
  });
});
