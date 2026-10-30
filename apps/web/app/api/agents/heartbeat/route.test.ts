import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));
let authed: { id: string; organizationId: string; paused: boolean; reported?: Record<string, unknown> } | null;
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => authed }));
let fake: ReturnType<typeof fakeSupabase>;
let respond: (c: FakeCall) => FakeResult;
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => fake.client }));

import { POST } from "./route";

const PRINTER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const post = (body: unknown) => POST(new Request("http://x/api/agents/heartbeat", { method: "POST", body: JSON.stringify(body) }));
const printerUpdates = () => fake.calls.filter((c) => c.table === "printers" && c.op === "update");

beforeEach(() => {
  authed = { id: "agent-1", organizationId: "org-1", paused: false };
  respond = (c) => (c.table === "printer_profiles" && c.op === "select" ? ok([{ printer_id: PRINTER, output_mode: "raw", raw_host: "192.168.100.168", raw_port: 9100, windows_queue_name: null }]) : ok());
  fake = fakeSupabase((c) => respond(c));
});

describe("heartbeat: direct-port printers", () => {
  it("tells the agent which direct-port printers to ask about", async () => {
    const res = await post({ version: "1.0.0" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, paused: false, rawPrinters: [{ printerId: PRINTER, host: "192.168.100.168", port: 9100 }] });
  });

  it("stores what the printer says, only for the agent's own printers and inside the agent's organization", async () => {
    await post({ version: "1.0.0", rawPrinters: [{ printerId: PRINTER, reachable: true, answered: true, online: true, code: 40022, display: "Add paper in cassette 2" }, { printerId: OTHER, reachable: true, answered: true, code: 10001, display: "Ready" }] });
    const updates = printerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({ status: "error", status_detail: "Add paper in cassette 2", status_code: 40022 });
    expect(updates[0]!.filters).toEqual(expect.arrayContaining([["eq", "id", PRINTER], ["eq", "organization_id", "org-1"]]));
  });

  it("a heartbeat with no report (an older agent) changes no printer", async () => {
    const res = await post({ version: "0.9.0", queues: [] });
    expect(res.status).toBe(200);
    expect(printerUpdates()).toHaveLength(0);
  });

  it("refuses an unauthenticated caller and does nothing", async () => {
    authed = null;
    const res = await post({ rawPrinters: [{ printerId: PRINTER, reachable: true, answered: true }] });
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("heartbeat: write reduction", () => {
  const Q1 = "33333333-3333-4333-8333-333333333333";
  const Q2 = "44444444-4444-4444-8444-444444444444";
  const recent = () => new Date(Date.now() - 30_000).toISOString();
  const profileRows = (statuses: Record<string, { status: string; last_status_at: string | null }>) => [
    { printer_id: Q1, windows_queue_name: "Q1", output_mode: "windows", raw_host: null, raw_port: null, printers: statuses[Q1] },
    { printer_id: Q2, windows_queue_name: "Q2", output_mode: "windows", raw_host: null, raw_port: null, printers: statuses[Q2] },
  ];
  const agentUpdates = () => fake.calls.filter((c) => c.table === "agents" && c.op === "update");

  it("reads printer_profiles once per heartbeat", async () => {
    await post({ version: "1", queues: [{ windowsQueueName: "Q1", status: "ready" }] });
    expect(fake.calls.filter((c) => c.table === "printer_profiles" && c.op === "select")).toHaveLength(1);
  });

  it("does not rewrite printers whose status is unchanged and recently stamped; writes changed ones in one grouped update with the org filter", async () => {
    respond = (c) => (c.table === "printer_profiles" ? ok(profileRows({ [Q1]: { status: "online", last_status_at: recent() }, [Q2]: { status: "online", last_status_at: recent() } })) : ok());
    fake = fakeSupabase((c) => respond(c));
    await post({ version: "1", queues: [{ windowsQueueName: "Q1", status: "ready" }, { windowsQueueName: "Q2", status: "offline" }] });
    const updates = printerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({ status: "offline" });
    expect(updates[0]!.filters).toEqual(expect.arrayContaining([["in", "id", [Q2]], ["eq", "organization_id", "org-1"]]));
  });

  it("refreshes last_status_at when it has gone stale even if the status is unchanged", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    respond = (c) => (c.table === "printer_profiles" ? ok(profileRows({ [Q1]: { status: "online", last_status_at: old }, [Q2]: { status: "online", last_status_at: recent() } })) : ok());
    fake = fakeSupabase((c) => respond(c));
    await post({ version: "1", queues: [{ windowsQueueName: "Q1", status: "ready" }, { windowsQueueName: "Q2", status: "ready" }] });
    const updates = printerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual(expect.arrayContaining([["in", "id", [Q1]]]));
  });

  it("only touches last_seen_at on the agents row when nothing it reported changed (reportedAt ignored)", async () => {
    authed = { id: "agent-1", organizationId: "org-1", paused: false, reported: { version: "1", discovered_queues: [{ windowsQueueName: "Q1", status: "ready", reportedAt: "2020-01-01T00:00:00Z" }], hostname: "pc", os_version: null, ip_addresses: null, is_git_checkout: null } } as typeof authed;
    await post({ version: "1", queues: [{ windowsQueueName: "Q1", status: "ready" }], machine: { hostname: "pc" } });
    expect(agentUpdates()).toHaveLength(1);
    expect(Object.keys(agentUpdates()[0]!.values as object)).toEqual(["last_seen_at"]);
  });

  it("writes the changed fields when they differ", async () => {
    authed = { id: "agent-1", organizationId: "org-1", paused: false, reported: { version: "1", discovered_queues: [], hostname: "pc", os_version: null, ip_addresses: null, is_git_checkout: null } } as typeof authed;
    await post({ version: "2", queues: [{ windowsQueueName: "Q1", status: "ready" }], machine: { hostname: "pc2" } });
    expect(agentUpdates()[0]!.values).toMatchObject({ version: "2", hostname: "pc2", discovered_queues: [{ windowsQueueName: "Q1", status: "ready", reportedAt: expect.any(String) }] });
  });
});
