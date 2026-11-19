import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const agentRow = { id: "agent1", organizationId: "org1", paused: false };
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => agentRow }));
vi.mock("@/lib/lease-recovery", () => ({ recoverExpiredLeasesForAgent: async () => ({}) }));
vi.mock("@/lib/agent-commands", () => ({ listCommandsForAgent: async () => [] }));

type Row = Record<string, unknown>;
let serverJobs: Row[] = [];
let serverJobsError: { message: string } | null = null;
let serverJobQueries = 0;
const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

const service = {
  from(table: string) {
    if (table === "printer_profiles") {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, then: (r: (v: unknown) => void) => r({ data: [{ id: "prof1" }], error: null }) };
      return q;
    }
    if (table === "server_jobs") {
      serverJobQueries += 1;
      const eqs: Array<[string, unknown]> = [];
      let or = "";
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
        or: (e: string) => ((or = e), q),
        limit: () => q,
        then: (r: (v: unknown) => void) => {
          const cutoff = /lease_until\.lt\.([^,)]+)/.exec(or)?.[1];
          const rows = serverJobs.filter((j) => eqs.every(([k, v]) => j[k] === v) && (j.status === "queued" || (j.status === "claimed" && cutoff && Date.parse(j.lease_until as string) < Date.parse(cutoff))));
          r({ data: rows, error: serverJobsError });
        },
      };
      return q;
    }
    // print_jobs: nothing claimable
    const q: Record<string, unknown> = { select: () => q, eq: () => q, in: () => q, or: () => q, order: () => q, limit: () => q, then: (r: (v: unknown) => void) => r({ data: [], error: null }) };
    return q;
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { GET } from "./route";
const call = (qs: string) => GET(new Request(`http://x/api/agents/jobs/claimable${qs}`));
const prep = (over: Row = {}): Row => ({ kind: "prepare_pdf", organization_id: "org1", status: "queued", lease_until: null, ...over });

beforeEach(() => { serverJobs = []; serverJobsError = null; serverJobQueries = 0; });

describe("claimable ?prepare=1", () => {
  it("without the flag the answer is unchanged and no prepare query runs", async () => {
    serverJobs = [prep()];
    expect(await (await call("")).json()).toEqual({ jobs: [] });
    expect(await (await call("?commands=1")).json()).toEqual({ jobs: [], commands: [] });
    expect(serverJobQueries).toBe(0);
  });
  it("says true when a queued prepare job of this school is waiting", async () => {
    serverJobs = [prep()];
    expect(await (await call("?prepare=1")).json()).toEqual({ jobs: [], prepareWaiting: true });
  });
  it("says false when nothing is waiting", async () => {
    expect(await (await call("?prepare=1")).json()).toEqual({ jobs: [], prepareWaiting: false });
  });
  it("another school's job never counts, and a library job is not a prepare job", async () => {
    serverJobs = [prep({ organization_id: "org2" }), prep({ kind: "library_fetch" })];
    expect((await (await call("?prepare=1")).json()).prepareWaiting).toBe(false);
  });
  it("a claimed job counts only once its lease has expired", async () => {
    serverJobs = [prep({ status: "claimed", lease_until: FUTURE })];
    expect((await (await call("?prepare=1")).json()).prepareWaiting).toBe(false);
    serverJobs = [prep({ status: "claimed", lease_until: PAST })];
    expect((await (await call("?prepare=1")).json()).prepareWaiting).toBe(true);
  });
  it("works together with the commands flag", async () => {
    serverJobs = [prep()];
    expect(await (await call("?commands=1&prepare=1")).json()).toEqual({ jobs: [], commands: [], prepareWaiting: true });
  });
  it("a failed lookup leaves the field out and never fails the poll", async () => {
    serverJobsError = { message: "boom" };
    const res = await call("?prepare=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });
  });
});
