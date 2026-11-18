import { beforeEach, describe, expect, it, vi } from "vitest";

let agentRow: { id: string; organizationId: string; paused: boolean } = { id: "agent1", organizationId: "org1", paused: false };
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => agentRow }));

type Row = Record<string, unknown>;
let jobs: Row[];
let profileRows: Row[] = [{ id: "prof1" }];
let jobsError: { message: string } | null = null;
let lastJobQuery: { orders: Array<[string, unknown]>; limit: number | null; or: string | null; eqs: Array<[string, unknown]> };

/** Applies the same filters PostgREST would, so an ordering/limit bug shows up as wrong output, not only as a wrong call. */
const service = {
  from(table: string) {
    if (table === "printer_profiles") {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ data: profileRows, error: null }),
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
        resolve({ data: rows, error: jobsError });
      },
    };
    return q;
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

const recover = vi.fn(async (..._a: unknown[]) => ({ releasedLeases: 0, failedFromStaleLease: 0, autoRetried: 0 }) as unknown);
vi.mock("@/lib/lease-recovery", () => ({ recoverExpiredLeasesForAgent: (...a: unknown[]) => recover(...a) }));

const listCommands = vi.fn(async (..._a: unknown[]) => [] as unknown);
vi.mock("@/lib/agent-commands", () => ({ listCommandsForAgent: (...a: unknown[]) => listCommands(...a) }));

import { GET } from "./route";

const get = () => GET(new Request("http://x"));
const getWithCommands = () => GET(new Request("http://x/api/agents/jobs/claimable?commands=1"));
const job = (n: number, over: Row = {}): Row => ({
  id: `j${n}`, job_number: `JOB-${n}`, printer_profile_id: "prof1", status: "approved", lease_expires_at: null,
  created_at: new Date(Date.UTC(2026, 9, 23, 8, 0, n)).toISOString(), ...over,
});

beforeEach(() => {
  recover.mockClear();
  listCommands.mockReset();
  listCommands.mockResolvedValue([]);
  profileRows = [{ id: "prof1" }];
  jobsError = null;
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

describe("claimable jobs: self-healing", () => {
  it("recovers this agent's expired leases (scoped to its org and printer profiles) before listing work", async () => {
    jobs = [job(1)];
    await get();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]![1]).toEqual({ organizationId: "org1", agentId: "agent1", printerProfileIds: ["prof1"] });
  });

  it("does not recover anything for a paused agent", async () => {
    agentRow = { id: "agent1", organizationId: "org1", paused: true };
    await get();
    expect(recover).not.toHaveBeenCalled();
  });

  it("still answers when recovery reports a failure (it returns null instead of throwing)", async () => {
    recover.mockResolvedValueOnce(null);
    jobs = [job(1)];
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).jobs).toHaveLength(1);
  });
});

describe("claimable jobs: ?commands=1 (one call per cycle instead of two)", () => {
  const waiting = [{ id: "c1", command: "CHECK_FOR_UPDATE", payload: { checkOnly: true } }];

  it("without the flag the answer is exactly what an older agent always got: no commands field, commands not even looked up", async () => {
    jobs = [job(1)];
    listCommands.mockResolvedValue(waiting);
    const body = await (await get()).json();
    expect(Object.keys(body)).toEqual(["jobs"]);
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("only the exact value 1 turns it on", async () => {
    for (const q of ["?commands=0", "?commands=true", "?commands="]) {
      const body = await (await GET(new Request(`http://x/api/agents/jobs/claimable${q}`))).json();
      expect(body).not.toHaveProperty("commands");
    }
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("with the flag it returns the jobs and the pending commands, looked up for this agent only", async () => {
    jobs = [job(1), job(2)];
    listCommands.mockResolvedValue(waiting);
    const body = await (await getWithCommands()).json();
    expect(body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(["j1", "j2"]);
    expect(body.commands).toEqual(waiting);
    expect(listCommands).toHaveBeenCalledTimes(1);
    expect(listCommands.mock.calls[0]![1]).toBe("agent1");
  });

  it("returns an empty commands list (not a missing field) when nothing is waiting, so the agent knows the website supports it", async () => {
    jobs = [];
    const body = await (await getWithCommands()).json();
    expect(body).toEqual({ jobs: [], commands: [] });
  });

  it("a paused agent still gets its commands (as on the commands route) but never a job, and nothing is recovered", async () => {
    agentRow = { id: "agent1", organizationId: "org1", paused: true };
    jobs = [job(1)];
    listCommands.mockResolvedValue(waiting);
    const body = await (await getWithCommands()).json();
    expect(body).toEqual({ jobs: [], commands: waiting });
    expect(recover).not.toHaveBeenCalled();
  });

  it("an agent with no printers gets its commands too", async () => {
    profileRows = [];
    listCommands.mockResolvedValue(waiting);
    expect(await (await getWithCommands()).json()).toEqual({ jobs: [], commands: waiting });
  });

  it("if the commands lookup fails, the field is left out and the jobs still arrive (the agent then asks the commands route)", async () => {
    jobs = [job(1)];
    listCommands.mockResolvedValue(null);
    const res = await getWithCommands();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body).not.toHaveProperty("commands");
    listCommands.mockRejectedValue(new Error("boom"));
    expect((await (await getWithCommands()).json())).not.toHaveProperty("commands");
  });

  it("a failed job list is still a 500, and no command is handed out (and so marked picked up) on that failed answer", async () => {
    jobsError = { message: "db down" };
    const res = await getWithCommands();
    expect(res.status).toBe(500);
    expect(listCommands).not.toHaveBeenCalled();
  });
});
