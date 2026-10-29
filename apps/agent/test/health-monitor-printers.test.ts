import { describe, expect, it, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import { createHealthMonitor } from "../src/health-monitor.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });
const PRINTER = "11111111-1111-4111-8111-111111111111";
const TARGET = { printerId: PRINTER, host: "192.168.100.168", port: 9100 };

function setup(opts: { responses?: Array<Record<string, unknown>>; sending?: boolean; probe?: ReturnType<typeof vi.fn>; check?: ReturnType<typeof vi.fn>; probeIntervalMs?: number } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const responses = [...(opts.responses ?? [{ ok: true, serverTime: "t", rawPrinters: [TARGET] }])];
  const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const r = responses.length > 1 ? responses.shift()! : responses[0]!;
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new CloudClient({ apiUrl: "https://cloud.example", agentId: "agent-1", deviceSecret: "secret", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
  const probe = opts.probe ?? vi.fn(async () => ({ reachable: true, answered: true, online: true, code: 10001, display: "Ready" }));
  const check = opts.check ?? vi.fn(async (t: { host: string; port: number }) => ({ ok: true as const, host: t.host, port: t.port }));
  const monitor = createHealthMonitor(client, { discoverQueues: vi.fn(async () => []), restartSpooler: vi.fn(async () => {}) }, logger, {
    probe,
    checkTarget: check,
    isSending: () => opts.sending === true,
    probeIntervalMs: opts.probeIntervalMs ?? 0,
  });
  return { monitor, bodies, probe, check };
}

describe("heartbeat: not asking too often", () => {
  it("asks at most once per interval, so the printer is free to sleep (heartbeats come every few seconds)", async () => {
    const { monitor, bodies, probe } = setup({ probeIntervalMs: 60_000 });
    await monitor.sendHeartbeat(); // learns the printers
    await monitor.sendHeartbeat(); // first ask
    await monitor.sendHeartbeat();
    await monitor.sendHeartbeat();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(bodies[1]).toHaveProperty("rawPrinters");
    expect(bodies[2]).not.toHaveProperty("rawPrinters");
    expect(bodies[3]).not.toHaveProperty("rawPrinters");
  });
});

describe("heartbeat: asking the direct-port printers how they are", () => {
  it("learns which printers to ask from the first answer, then reports what each says with the next heartbeat", async () => {
    const { monitor, bodies, probe } = setup();
    await monitor.sendHeartbeat();
    expect(bodies[0]).not.toHaveProperty("rawPrinters"); // nothing known yet
    await monitor.sendHeartbeat();
    expect(probe).toHaveBeenCalledWith({ host: "192.168.100.168", port: 9100 });
    expect(bodies[1]!.rawPrinters).toEqual([{ printerId: PRINTER, reachable: true, answered: true, online: true, code: 10001, display: "Ready" }]);
  });

  it("never asks while a job is being sent (the printer's port may take only one connection)", async () => {
    const { monitor, bodies, probe } = setup({ sending: true });
    await monitor.sendHeartbeat();
    await monitor.sendHeartbeat();
    expect(probe).not.toHaveBeenCalled();
    expect(bodies[1]).not.toHaveProperty("rawPrinters");
  });

  it("only asks printers on the allowed private network, and a refused address is left out of the report", async () => {
    const check = vi.fn(async () => ({ ok: false as const, reason: "not private" }));
    const { monitor, bodies, probe } = setup({ check });
    await monitor.sendHeartbeat();
    await monitor.sendHeartbeat();
    expect(probe).not.toHaveBeenCalled();
    expect(bodies[1]).not.toHaveProperty("rawPrinters");
  });

  it("a probe that fails is reported as unreachable and never breaks the heartbeat", async () => {
    const probe = vi.fn(async () => {
      throw new Error("boom");
    });
    const { monitor, bodies } = setup({ probe });
    await monitor.sendHeartbeat();
    expect(await monitor.sendHeartbeat()).toBe(true);
    expect(bodies[1]!.rawPrinters).toEqual([{ printerId: PRINTER, reachable: false, answered: false }]);
  });

  it("ignores a malformed printer list from the cloud, and an older cloud that sends none", async () => {
    const { monitor, bodies, probe } = setup({ responses: [{ ok: true, serverTime: "t", rawPrinters: [{ host: 5 }, "x", null] }] });
    await monitor.sendHeartbeat();
    await monitor.sendHeartbeat();
    expect(probe).not.toHaveBeenCalled();
    const older = setup({ responses: [{ ok: true, serverTime: "t" }] });
    await older.monitor.sendHeartbeat();
    await older.monitor.sendHeartbeat();
    expect(older.probe).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(2);
  });
});
