import { describe, expect, it, vi } from "vitest";
import type os from "node:os";
import { collectIpAddresses, collectMachineInfo, describeOs } from "../src/machine-info.js";
import { createHealthMonitor } from "../src/health-monitor.js";
import { CloudClient } from "../src/cloud-client.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

function iface(address: string, internal: boolean, family: "IPv4" | "IPv6" = "IPv4"): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  } as os.NetworkInterfaceInfo;
}

describe("collectIpAddresses", () => {
  it("excludes loopback/internal interfaces - 127.0.0.1 tells an admin nothing about which network this machine is on", () => {
    const addresses = collectIpAddresses({
      lo: [iface("127.0.0.1", true)],
      Ethernet: [iface("10.0.0.5", false)],
    });
    expect(addresses).toEqual(["10.0.0.5"]);
  });

  it("collects across every interface, deduplicated and stably ordered", () => {
    const addresses = collectIpAddresses({
      Ethernet: [iface("10.0.0.5", false), iface("fe80::1", false, "IPv6")],
      "Wi-Fi": [iface("192.168.1.20", false), iface("10.0.0.5", false)],
    });
    expect(addresses).toEqual(["10.0.0.5", "192.168.1.20", "fe80::1"]);
  });

  it("returns an empty list rather than throwing when there are no usable interfaces", () => {
    expect(collectIpAddresses({})).toEqual([]);
    expect(collectIpAddresses({ Ethernet: undefined })).toEqual([]);
  });
});

describe("describeOs", () => {
  it("assembles a single readable line, since no one os.* call gives one", () => {
    expect(describeOs("Windows_NT", "10.0.19045", "x64")).toBe("Windows_NT 10.0.19045 (x64)");
  });
});

describe("collectMachineInfo", () => {
  it("returns every field, with no secrets and no throwing", () => {
    const info = collectMachineInfo();
    expect(typeof info.hostname).toBe("string");
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(typeof info.osVersion).toBe("string");
    expect(Array.isArray(info.ipAddresses)).toBe(true);
    expect(typeof info.isGitCheckout).toBe("boolean");
    // No usernames, paths, MACs, or serials - the shape is exactly these four.
    expect(Object.keys(info).sort()).toEqual(["hostname", "ipAddresses", "isGitCheckout", "osVersion"]);
  });
});

describe("heartbeat machine reporting and the paused signal", () => {
  function fakeCloud(response: Record<string, unknown>) {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    });
    return { bodies, fetchImpl };
  }

  function makeMonitor(fetchImpl: ReturnType<typeof vi.fn>) {
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-1",
      deviceSecret: "secret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const printerManager = {
      discoverQueues: vi.fn(async () => []),
      restartSpooler: vi.fn(async () => {}),
    };
    return createHealthMonitor(client, printerManager, logger);
  }

  it("sends the machine block on every heartbeat", async () => {
    const { bodies, fetchImpl } = fakeCloud({ ok: true, serverTime: "2026-01-01T00:00:00Z" });
    const monitor = makeMonitor(fetchImpl);

    expect(await monitor.sendHeartbeat()).toBe(true);

    const body = bodies[0] as { machine?: Record<string, unknown> };
    expect(body.machine).toBeDefined();
    expect(typeof body.machine?.hostname).toBe("string");
    expect(Array.isArray(body.machine?.ipAddresses)).toBe(true);
  });

  it("picks up a `paused: true` heartbeat response so the Agent can stop asking for work", async () => {
    const { fetchImpl } = fakeCloud({ ok: true, serverTime: "2026-01-01T00:00:00Z", paused: true });
    const monitor = makeMonitor(fetchImpl);

    expect(monitor.isPaused()).toBe(false);
    await monitor.sendHeartbeat();
    expect(monitor.isPaused()).toBe(true);
  });

  it("treats a response with no `paused` field (an older server) as not paused - nothing changes for an existing deployment", async () => {
    const { fetchImpl } = fakeCloud({ ok: true, serverTime: "2026-01-01T00:00:00Z" });
    const monitor = makeMonitor(fetchImpl);

    await monitor.sendHeartbeat();
    expect(monitor.isPaused()).toBe(false);
  });

  it("keeps a pause in force across a failed heartbeat - a network blip must never silently un-pause a held machine", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ ok: true, serverTime: "t", paused: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new TypeError("fetch failed");
    });
    const monitor = makeMonitor(fetchImpl as ReturnType<typeof vi.fn>);

    await monitor.sendHeartbeat();
    expect(monitor.isPaused()).toBe(true);

    expect(await monitor.sendHeartbeat()).toBe(false);
    expect(monitor.isPaused()).toBe(true);
  }, 20_000);
});
