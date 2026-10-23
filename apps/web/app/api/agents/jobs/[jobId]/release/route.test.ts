import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatWaitingMarker, parseWaitingMarker, gaveUpMessage, WAITING_UNAVAILABLE_TEXT } from "@printio/shared";

const adjust = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/quota", async (orig) => ({ ...(await orig<typeof import("@/lib/quota")>()), adjustMonthlyUsage: (...a: unknown[]) => adjust(...a) }));
let agentRow: { id: string; organizationId: string; paused: boolean } | null = { id: "agent1", organizationId: "org1", paused: false };
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => agentRow }));

type Row = Record<string, unknown>;
let job: Row;
const events: Row[] = [];

// Same fake as the status route test: every UPDATE is applied only when all its eq() filters match the row.
const service = {
  from(table: string) {
    if (table === "print_job_events") return { insert: async (v: Row) => (events.push(v), { error: null }) };
    let patch: Row | null = null;
    const eqs: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => ((patch = p), q),
      eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
      maybeSingle: async () => ({ data: eqs.every(([k, v]) => job[k] === v) ? { ...job } : null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const ok = eqs.every(([k, v]) => job[k] === v);
        if (ok && patch) job = { ...job, ...patch };
        resolve({ data: ok ? [{ id: job.id }] : [], error: null });
      },
    };
    return q;
  },
};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ jobId: "j1" }) });

const claimed = (over: Row = {}): Row => ({
  id: "j1", organization_id: "org1", created_by: "u1", status: "claimed", lease_owner_agent_id: "agent1", lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
  attempt_count: 0, max_attempts: 3, error_message: null, is_test_print: false, source_pdf_pages: 2, copies: 1,
  estimated_printed_sides: 2, estimated_physical_sheets: 1, color_mode: "bw", ...over,
});

beforeEach(() => {
  job = claimed();
  agentRow = { id: "agent1", organizationId: "org1", paused: false };
  events.length = 0;
  adjust.mockClear();
  delete process.env.PRINTIO_WAITING_WINDOW_MINUTES;
});

describe("agent release route: waiting, not failed", () => {
  it("first release: back to approved, hidden for 30 s, marker stored, attempts and quota untouched", async () => {
    const before = Date.now();
    const res = await call({ kind: "unavailable" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, outcome: "waiting", tries: 1 });
    expect(job).toMatchObject({ status: "approved", lease_owner_agent_id: null, attempt_count: 0 });
    const hiddenUntil = Date.parse(job.lease_expires_at as string);
    expect(hiddenUntil).toBeGreaterThanOrEqual(before + 30_000);
    expect(hiddenUntil).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(body.retryAt).toBe(job.lease_expires_at);
    expect(parseWaitingMarker(job.error_message as string)).toMatchObject({ kind: "unavailable", tries: 1, text: WAITING_UNAVAILABLE_TEXT });
    expect(adjust).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "RETRY_SCHEDULED", actor_type: "agent" });
    expect(events[0]!.metadata).toMatchObject({ waiting: true, kind: "unavailable" });
  });

  it("later releases keep the original 'since', grow the backoff and do not spam the event history", async () => {
    const since = Math.floor((Date.now() - 10 * 60_000) / 1000) * 1000;
    job = claimed({ error_message: formatWaitingMarker({ since, tries: 3, kind: "unavailable" }) });
    const res = await call({ kind: "unavailable" });
    expect((await res.json()).tries).toBe(4);
    const info = parseWaitingMarker(job.error_message as string)!;
    expect(info.since).toBe(since);
    expect(Date.parse(job.lease_expires_at as string) - Date.now()).toBeGreaterThan(290_000);
    expect(events).toHaveLength(0);
  });

  it("an unknown cause is stored as 'status unknown'", async () => {
    await call({ kind: "unknown" });
    expect(parseWaitingMarker(job.error_message as string)?.kind).toBe("unknown");
    expect(job.error_message as string).toContain("Waiting for the printer - status unknown");
  });

  it("after the window it becomes failed with a plain message, no attempt consumed, quota still reserved, never auto-requeued", async () => {
    job = claimed({ error_message: formatWaitingMarker({ since: Date.now() - 3 * 3600_000, tries: 30, kind: "unavailable" }) });
    const res = await call({ kind: "unavailable" });
    expect(await res.json()).toMatchObject({ ok: true, outcome: "failed" });
    expect(job).toMatchObject({ status: "failed", attempt_count: 0, error_message: gaveUpMessage(2 * 3600_000) });
    expect(adjust).not.toHaveBeenCalled();
    expect(events.map((e) => e.event_type)).toEqual(["PRINT_FAILED"]);
  });

  it("the window can be changed with PRINTIO_WAITING_WINDOW_MINUTES", async () => {
    process.env.PRINTIO_WAITING_WINDOW_MINUTES = "10";
    job = claimed({ error_message: formatWaitingMarker({ since: Date.now() - 11 * 60_000, tries: 5, kind: "unknown" }) });
    expect((await (await call({ kind: "unknown" })).json()).outcome).toBe("failed");
    expect(job.error_message).toBe(gaveUpMessage(10 * 60_000));
  });

  it("a bad window setting falls back to the 2 hour default", async () => {
    process.env.PRINTIO_WAITING_WINDOW_MINUTES = "banana";
    job = claimed({ error_message: formatWaitingMarker({ since: Date.now() - 100 * 60_000, tries: 5, kind: "unknown" }) });
    expect((await (await call({ kind: "unknown" })).json()).outcome).toBe("waiting");
  });

  it("an old non-marker error text on the row does not start the clock in the past", async () => {
    job = claimed({ error_message: "spooler offline" });
    expect((await (await call({ kind: "unavailable" })).json()).tries).toBe(1);
  });
});

describe("agent release route: authorization and races", () => {
  it("unauthenticated agents are refused before anything is read", async () => {
    agentRow = null;
    expect((await call({ kind: "unknown" })).status).toBe(401);
  });
  it("another organization's job is a 404", async () => {
    job = claimed({ organization_id: "other" });
    expect((await call({ kind: "unknown" })).status).toBe(404);
    expect(job.status).toBe("claimed");
  });
  it("an agent that does not hold the lease is refused (403)", async () => {
    job = claimed({ lease_owner_agent_id: "agent2" });
    expect((await call({ kind: "unknown" })).status).toBe(403);
    expect(job.status).toBe("claimed");
  });
  it("only a claimed job can be released (409), so a half-sent job is never re-queued", async () => {
    for (const status of ["approved", "downloading", "downloaded", "printing", "submitted_to_spooler", "completed", "failed", "cancelled"]) {
      job = claimed({ status });
      const res = await call({ kind: "unknown" });
      expect(res.status, status).toBe(409);
      expect(job.status).toBe(status);
    }
  });
  it("rejects a missing/invalid kind and non-JSON bodies", async () => {
    expect((await call({ kind: "melted" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call("not json")).status).toBe(400);
  });
  it("two overlapping releases (agent retry after a timeout): exactly one wins, one event, one marker", async () => {
    const [a, b] = await Promise.all([call({ kind: "unavailable" }), call({ kind: "unavailable" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(events).toHaveLength(1);
    expect(parseWaitingMarker(job.error_message as string)?.tries).toBe(1);
  });
  it("a test print is released the same way and never touches quota", async () => {
    job = claimed({ is_test_print: true });
    expect((await call({ kind: "unavailable" })).status).toBe(200);
    expect(adjust).not.toHaveBeenCalled();
  });
});
