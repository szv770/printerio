import { describe, expect, it, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import { createHealthMonitor } from "../src/health-monitor.js";
import { createLogger } from "../src/logger.js";
import { effectivePollSeconds } from "../src/config.js";

const logger = createLogger({ level: "error" });

function monitorFor(response: Record<string, unknown>) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }));
  const client = new CloudClient({ apiUrl: "https://cloud.example", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
  return createHealthMonitor(client, { discoverQueues: vi.fn(async () => []), restartSpooler: vi.fn(async () => {}) }, logger, { probeIntervalMs: 0 });
}

describe("effectivePollSeconds", () => {
  it("uses the admin's value when it is valid, otherwise the PC's own setting", () => {
    expect(effectivePollSeconds(3, 10)).toBe(10);
    expect(effectivePollSeconds(3, null)).toBe(3);
    expect(effectivePollSeconds(3, 1)).toBe(3); // below the floor
    expect(effectivePollSeconds(3, 999)).toBe(3); // above the ceiling
    expect(effectivePollSeconds(3, 2)).toBe(2);
    expect(effectivePollSeconds(3, 300)).toBe(300);
  });
});

describe("heartbeat carries the admin's poll speed", () => {
  it("remembers a valid value and forgets it when the admin clears it", async () => {
    const m = monitorFor({ ok: true, serverTime: "t", pollIntervalSeconds: 12 });
    expect(m.adminPollSeconds()).toBeNull();
    await m.sendHeartbeat();
    expect(m.adminPollSeconds()).toBe(12);
    const cleared = monitorFor({ ok: true, serverTime: "t", pollIntervalSeconds: null });
    await cleared.sendHeartbeat();
    expect(cleared.adminPollSeconds()).toBeNull();
  });

  it("ignores junk from an older or odd server", async () => {
    const m = monitorFor({ ok: true, serverTime: "t", pollIntervalSeconds: "fast" });
    await m.sendHeartbeat();
    expect(m.adminPollSeconds()).toBeNull();
  });
});
