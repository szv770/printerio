import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));
let authed: { id: string; organizationId: string; paused: boolean } | null;
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
