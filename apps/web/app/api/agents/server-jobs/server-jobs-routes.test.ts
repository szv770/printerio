import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "@/test/memory-db";

const auth = vi.hoisted(() => ({ agent: { id: "agent1", organizationId: "orgA", paused: false } as null | { id: string; organizationId: string; paused: boolean } }));
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => auth.agent }));
const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => dbBox.client }));

import { POST as claim } from "./claim/route";
import { POST as complete } from "./[jobId]/complete/route";
import { POST as fail } from "./[jobId]/fail/route";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEntryPage, parseLikkutSichos, parseListPage } from "@printio/shared/library/mafteiach-parse";

const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";
const J3 = "33333333-3333-4333-8333-333333333333";
const fixture = (n: string) => readFileSync(join(__dirname, "../../../../../../packages/shared/src/library/fixtures", n), "utf8");

let mem: ReturnType<typeof memoryDb>;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const job = (id: string, over: Row = {}): Row => ({
  id, kind: "library_fetch", organization_id: "orgB", requested_by: "u1",
  params: { kind: "likkutei", volume: 1 }, dedupe_key: "likkutei:1",
  status: "queued", claimed_by: null, lease_until: null, result_key: null, error: null, created_at: minutesAgo(2), updated_at: minutesAgo(2), ...over,
});

const req = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x", { method: "POST", headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const doComplete = (jobId: string, body: unknown, headers?: Record<string, string>) => complete(req(body, headers), ctx(jobId));
const doFail = (jobId: string, body: unknown) => fail(req(body), ctx(jobId));
const likkutPayload = () => parseLikkutSichos(fixture("likkutei-volume.html"));
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  auth.agent = { id: "agent1", organizationId: "orgA", paused: false };
  mem = memoryDb({ library_fetchers: [{ agent_id: "agent1" }], server_jobs: [], library_pages: [] });
  dbBox.client = mem.client;
});

describe("every endpoint: who may call", () => {
  it("401 without valid agent credentials", async () => {
    auth.agent = null;
    expect((await claim(req())).status).toBe(401);
    expect((await doComplete(J1, { payload: {} })).status).toBe(401);
    expect((await doFail(J1, {})).status).toBe(401);
  });

  it("403 for a valid agent that is not in library_fetchers (even a school's own, active agent)", async () => {
    auth.agent = { id: "agent-other", organizationId: "orgB", paused: false };
    mem.tables.server_jobs = [job(J1, { status: "claimed", claimed_by: "agent-other", lease_until: inMinutes(1) })];
    for (const res of [await claim(req()), await doComplete(J1, { payload: likkutPayload() }), await doFail(J1, {})]) {
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("not_a_library_fetcher");
    }
    expect(mem.tables.library_pages).toEqual([]);
    expect(mem.tables.server_jobs[0]!.status).toBe("claimed"); // untouched
  });
});

describe("POST claim", () => {
  it("answers 204 when there is nothing to do", async () => {
    const res = await claim(req());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("claims the OLDEST queued job, leases it for 120 s and returns { jobId, kind, params } only (no address)", async () => {
    mem.tables.server_jobs = [
      job(J2, { created_at: minutesAgo(1), params: { kind: "likkutei", volume: 2 }, dedupe_key: "likkutei:2" }),
      job(J1, { created_at: minutesAgo(5) }),
    ];
    const res = await claim(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ jobId: J1, kind: "library_fetch", params: { kind: "likkutei", volume: 1 } });
    expect(JSON.stringify(body)).not.toMatch(/https?:/);
    const row = mem.tables.server_jobs.find((r) => r.id === J1)!;
    expect(row.status).toBe("claimed");
    expect(row.claimed_by).toBe("agent1");
    const lease = Date.parse(row.lease_until as string) - Date.now();
    expect(lease).toBeGreaterThan(115_000);
    expect(lease).toBeLessThanOrEqual(120_000);
    expect(mem.tables.server_jobs.find((r) => r.id === J2)!.status).toBe("queued");
  });

  it("does not hand out a job that is claimed with a live lease, nor finished ones; a second claim gets the next job or nothing", async () => {
    mem.tables.server_jobs = [
      job(J1, { status: "claimed", claimed_by: "agent-x", lease_until: inMinutes(1) }),
      job(J2, { status: "done" }),
      job(J3, { status: "failed" }),
    ];
    expect((await claim(req())).status).toBe(204);
  });

  it("takes over a job whose lease has expired", async () => {
    mem.tables.server_jobs = [job(J1, { status: "claimed", claimed_by: "agent-x", lease_until: minutesAgo(1) })];
    const res = await claim(req());
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBe(J1);
    expect(mem.tables.server_jobs[0]!.claimed_by).toBe("agent1");
    expect(Date.parse(mem.tables.server_jobs[0]!.lease_until as string)).toBeGreaterThan(Date.now());
  });

  it("two claims in a row never give the same job twice", async () => {
    mem.tables.server_jobs = [job(J1)];
    expect((await claim(req())).status).toBe(200);
    expect((await claim(req())).status).toBe(204);
  });

  it("first expires queued jobs older than 10 minutes (failed, error 'expired') and then claims a live one", async () => {
    mem.tables.server_jobs = [
      job(J1, { created_at: minutesAgo(11) }),
      job(J2, { created_at: minutesAgo(1), params: { kind: "likkutei", volume: 2 }, dedupe_key: "likkutei:2" }),
    ];
    const res = await claim(req());
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBe(J2);
    const old = mem.tables.server_jobs.find((r) => r.id === J1)!;
    expect(old.status).toBe("failed");
    expect(old.error).toBe("expired");
    expect(old.lease_until).toBeNull();
    // updated_at is "now", so the website's 'failed in the last 5 minutes' rule picks it up
    expect(Date.now() - Date.parse(old.updated_at as string)).toBeLessThan(5_000);
    expect(mem.tables.server_jobs.find((r) => r.id === J2)!.status).toBe("claimed");
  });

  it("when only expired jobs wait, they are failed and the answer is 204", async () => {
    mem.tables.server_jobs = [job(J1, { created_at: minutesAgo(30) }), job(J2, { created_at: minutesAgo(12), params: { kind: "likkutei", volume: 2 }, dedupe_key: "likkutei:2" })];
    expect((await claim(req())).status).toBe(204);
    expect(mem.tables.server_jobs.map((r) => [r.status, r.error])).toEqual([["failed", "expired"], ["failed", "expired"]]);
  });

  it("expiry touches only queued jobs: a claimed (even old), done or already failed job is left alone", async () => {
    mem.tables.server_jobs = [
      job(J1, { status: "claimed", claimed_by: "agent-x", lease_until: inMinutes(1), created_at: minutesAgo(60) }),
      job(J2, { status: "done", created_at: minutesAgo(60) }),
      job(J3, { status: "failed", error: "page not found", created_at: minutesAgo(60) }),
    ];
    expect((await claim(req())).status).toBe(204);
    expect(mem.tables.server_jobs.map((r) => [r.status, r.error])).toEqual([["claimed", null], ["done", null], ["failed", "page not found"]]);
  });

  it("an expiry that cannot be written does not stop the claim", async () => {
    mem.tables.server_jobs = [job(J1)];
    const real = mem.client.from.bind(mem.client);
    let first = true;
    (mem.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = real(t as never) as { update: (v: unknown) => unknown };
      if (first && t === "server_jobs") {
        first = false;
        return { update: () => ({ eq: () => ({ lt: async () => ({ data: null, error: { message: "db down" } }) }) }) };
      }
      return q;
    };
    expect((await claim(req())).status).toBe(200);
  });

  it("the claim is ONE conditional update naming the state it saw (so a lost race matches nothing)", async () => {
    mem.tables.server_jobs = [job(J1)];
    await claim(req());
    // the first update is the expiry sweep of old queued jobs; the claim is the one that names the job
    const upd = mem.log.filter((l) => l.table === "server_jobs" && l.op === "update").at(-1)!;
    expect(upd.filters).toContain(`eq id ${J1}`);
    expect(upd.filters).toContain("eq status queued");
  });
});

describe("POST complete", () => {
  const claimed = (over: Row = {}) => job(J1, { status: "claimed", claimed_by: "agent1", lease_until: inMinutes(1), ...over });

  it("happy path: validates, writes the shared cache under the key rebuilt from the job, and marks the job done", async () => {
    mem.tables.server_jobs = [claimed()];
    const payload = likkutPayload();
    const res = await doComplete(J1, { payload });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const page = mem.tables.library_pages[0]!;
    expect(page.key).toBe("likkutei:1");
    expect(page.kind).toBe("likkutei");
    expect(page.payload).toEqual(payload);
    expect(page.fetched_by).toBe("agent1");
    expect(page.source_url).toBe("https://www.mafteiach.app/likkutei_sichos/by_volume/1"); // built by the website, never taken from the request
    const ttl = Date.parse(page.expires_at as string) - Date.now();
    expect(Math.abs(ttl - 24 * 3600_000)).toBeLessThan(10_000);
    const row = mem.tables.server_jobs[0]!;
    expect(row.status).toBe("done");
    expect(row.result_key).toBe("likkutei:1");
    expect(row.lease_until).toBeNull();
  });

  it("single entries are kept for 7 days, lists for 24 hours; a repeat overwrites the same key", async () => {
    mem.tables.server_jobs = [claimed({ params: { kind: "entry", path: "/maamorim/1" }, dedupe_key: "entry:/maamorim/1" })];
    expect((await doComplete(J1, { payload: parseEntryPage(fixture("maamor-entry.html")) })).status).toBe(200);
    expect(Math.abs(Date.parse(mem.tables.library_pages[0]!.expires_at as string) - Date.now() - 7 * 24 * 3600_000)).toBeLessThan(10_000);
    mem.tables.server_jobs = [claimed({ params: { kind: "list", section: "maamorim" }, dedupe_key: "list:maamorim:current" })];
    expect((await doComplete(J1, { payload: parseListPage(fixture("maamorim-list.html")) })).status).toBe(200);
    expect(mem.tables.library_pages.map((p) => p.key)).toEqual(["entry:/maamorim/1", "list:maamorim:current"]);
    mem.tables.server_jobs = [claimed()];
    await doComplete(J1, { payload: likkutPayload() });
    mem.tables.server_jobs = [claimed()];
    await doComplete(J1, { payload: likkutPayload() });
    expect(mem.tables.library_pages.filter((p) => p.key === "likkutei:1")).toHaveLength(1);
  });

  it("an entry with zero sections is still accepted, but only cached for 10 minutes instead of 7 days", async () => {
    mem.tables.server_jobs = [claimed({ params: { kind: "entry", path: "/maamorim/1" }, dedupe_key: "entry:/maamorim/1" })];
    expect((await doComplete(J1, { payload: [] })).status).toBe(200);
    expect(mem.tables.server_jobs[0]!.status).toBe("done");
    const page = mem.tables.library_pages[0]!;
    expect(page.key).toBe("entry:/maamorim/1");
    expect(page.payload).toEqual([]);
    expect(Math.abs(Date.parse(page.expires_at as string) - Date.now() - 10 * 60_000)).toBeLessThan(10_000);
    // The same entry later fetched with real content overwrites it with the normal 7 days.
    mem.tables.server_jobs = [claimed({ params: { kind: "entry", path: "/maamorim/1" }, dedupe_key: "entry:/maamorim/1" })];
    expect((await doComplete(J1, { payload: parseEntryPage(fixture("maamor-entry.html")) })).status).toBe(200);
    expect(mem.tables.library_pages).toHaveLength(1);
    expect(Math.abs(Date.parse(mem.tables.library_pages[0]!.expires_at as string) - Date.now() - 7 * 24 * 3600_000)).toBeLessThan(10_000);
  });

  it("404 for an unknown job or a malformed id", async () => {
    expect((await doComplete(J2, { payload: likkutPayload() })).status).toBe(404);
    expect((await doComplete("not-a-uuid", { payload: likkutPayload() })).status).toBe(404);
  });

  it("403 when somebody else holds the lease", async () => {
    mem.tables.server_jobs = [claimed({ claimed_by: "agent-x" })];
    const res = await doComplete(J1, { payload: likkutPayload() });
    expect(res.status).toBe(403);
    expect(mem.tables.library_pages).toEqual([]);
    expect(mem.tables.server_jobs[0]!.status).toBe("claimed");
  });

  it("403 when the lease has expired (another agent may already be working on it)", async () => {
    mem.tables.server_jobs = [claimed({ lease_until: minutesAgo(1) })];
    const res = await doComplete(J1, { payload: likkutPayload() });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("no_lease");
    expect(mem.tables.library_pages).toEqual([]);
  });

  it("409 for a job that is already finished (a retry), and for one never claimed", async () => {
    mem.tables.server_jobs = [claimed({ status: "done" })];
    expect((await doComplete(J1, { payload: likkutPayload() })).status).toBe(409);
    mem.tables.server_jobs = [job(J1)];
    expect((await doComplete(J1, { payload: likkutPayload() })).status).toBe(403); // not the claimer
    expect(mem.tables.library_pages).toEqual([]);
  });

  it("400 for a malformed payload (and nothing is written)", async () => {
    mem.tables.server_jobs = [claimed()];
    for (const payload of ["hi", null, { volumes: [], current: null }, { ...likkutPayload(), surprise: true }, parseListPage(fixture("maamorim-list.html"))]) {
      const res = await doComplete(J1, { payload });
      expect(res.status, JSON.stringify(payload)?.slice(0, 40)).toBe(400);
    }
    expect((await doComplete(J1, {})).status).toBe(400); // no payload at all
    expect(mem.tables.library_pages).toEqual([]);
    expect(mem.tables.server_jobs[0]!.status).toBe("claimed");
  });

  it("400 for a body that is not JSON, or an empty page (the server should report a failure instead)", async () => {
    mem.tables.server_jobs = [claimed()];
    expect((await doComplete(J1, "{not json")).status).toBe(400);
    expect((await doComplete(J1, { payload: { volumes: [], current: null, parshiyos: [] } })).status).toBe(400);
  });

  it("413 for an oversized payload or body", async () => {
    mem.tables.server_jobs = [claimed()];
    const big = { ...likkutPayload(), parshiyos: [{ name: "x", entries: [{ id: "1", label: "l", summary: "s".repeat(10000), links: [] }] }] };
    const many = { volumes: [], current: null, parshiyos: Array.from({ length: 200 }, () => big.parshiyos[0]!) };
    expect((await doComplete(J1, { payload: many })).status).toBe(413);
    expect((await doComplete(J1, { payload: {} }, { "content-length": "5000000" })).status).toBe(413);
    expect((await doComplete(J1, { payload: { pad: "x".repeat(1_700_000) } })).status).toBe(413);
    expect(mem.tables.library_pages).toEqual([]);
  });

  it("refuses a body that carries a key or an address, and never writes under a key the request chose", async () => {
    mem.tables.server_jobs = [claimed()];
    for (const extra of [{ key: "likkutei:99" }, { url: "https://evil.example/" }, { sourceUrl: "https://www.mafteiach.app/x" }, { kind: "entry" }]) {
      const res = await doComplete(J1, { payload: likkutPayload(), ...extra });
      expect(res.status).toBe(400);
    }
    expect(mem.tables.library_pages).toEqual([]);
  });

  it("409 when the job's own stored key does not match its params (a tampered row is never trusted)", async () => {
    mem.tables.server_jobs = [claimed({ dedupe_key: "likkutei:99" })];
    expect((await doComplete(J1, { payload: likkutPayload() })).status).toBe(409);
    mem.tables.server_jobs = [claimed({ params: { kind: "entry", path: "https://evil.example/x" }, dedupe_key: "entry:https://evil.example/x" })];
    expect((await doComplete(J1, { payload: [] })).status).toBe(409);
    expect(mem.tables.library_pages).toEqual([]);
  });

  it("a payload of the wrong kind for the job is refused: a list cannot be written into a Likkutei key", async () => {
    mem.tables.server_jobs = [claimed()];
    expect((await doComplete(J1, { payload: parseListPage(fixture("maamorim-list.html")) })).status).toBe(400);
    expect(mem.tables.library_pages).toEqual([]);
  });

  it("500 (generic message, no database text) when the cache write fails", async () => {
    mem.tables.server_jobs = [claimed()];
    mem.state.failAll = false;
    const real = mem.client.from;
    (mem.client as { from: unknown }).from = (t: string) => (t === "library_pages" ? { upsert: () => ({ then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: "secret db detail" } }) }) } : real(t));
    const res = await doComplete(J1, { payload: likkutPayload() });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret db detail/);
    expect(mem.tables.server_jobs[0]!.status).toBe("claimed");
  });
});

describe("POST fail", () => {
  const claimed = (over: Row = {}) => job(J1, { status: "claimed", claimed_by: "agent1", lease_until: inMinutes(1), ...over });

  it("records a short error and marks the job failed", async () => {
    mem.tables.server_jobs = [claimed()];
    const res = await doFail(J1, { error: "The library page looks different today." });
    expect(res.status).toBe(200);
    const row = mem.tables.server_jobs[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The library page looks different today.");
    expect(row.lease_until).toBeNull();
  });

  it("truncates a long error, strips control characters, and fills in a plain message when none is given", async () => {
    mem.tables.server_jobs = [claimed()];
    await doFail(J1, { error: `a\u0000b\n${"x".repeat(2000)}` });
    const err = mem.tables.server_jobs[0]!.error as string;
    expect(err.length).toBeLessThanOrEqual(300);
    expect(err).not.toMatch(/[\u0000-\u001f]/);
    mem.tables.server_jobs = [claimed()];
    await doFail(J1, {});
    expect(mem.tables.server_jobs[0]!.error).toMatch(/could not get that page/i);
  });

  it("refuses without the lease: someone else's, an expired one, or an unknown job", async () => {
    mem.tables.server_jobs = [claimed({ claimed_by: "agent-x" })];
    expect((await doFail(J1, { error: "x" })).status).toBe(403);
    mem.tables.server_jobs = [claimed({ lease_until: minutesAgo(1) })];
    expect((await doFail(J1, { error: "x" })).status).toBe(403);
    expect((await doFail(J2, { error: "x" })).status).toBe(404);
    expect(mem.tables.server_jobs[0]!.status).toBe("claimed");
  });

  it("400 for a malformed body, and never accepts extra fields", async () => {
    mem.tables.server_jobs = [claimed()];
    expect((await doFail(J1, { error: 5 })).status).toBe(400);
    expect((await doFail(J1, { error: "x", url: "https://evil.example" })).status).toBe(400);
    expect(mem.tables.server_jobs[0]!.status).toBe("claimed");
  });
});
