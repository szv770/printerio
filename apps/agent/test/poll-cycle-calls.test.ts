import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrchestrator } from "../src/orchestrator.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";
import { CloudApiError, CloudNetworkError } from "../src/errors.js";
import { CloudClient, type RemoteCommandEnvelope } from "../src/cloud-client.js";
import { DEFAULT_HEARTBEAT_INTERVAL_SECONDS, loadConfig, parseHeartbeatSeconds } from "../src/config.js";

const logger = createLogger({ level: "error" });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "printio-cycle-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cancel = (id: string): RemoteCommandEnvelope => ({ id, command: "CANCEL_PRINT_JOB", payload: { jobId: "none" } }) as RemoteCommandEnvelope;

interface FakeOpts {
  /** What the one combined call answers; `undefined` commands = an older website that ignores the flag. */
  combined?: () => Promise<{ jobs: unknown[]; commands: RemoteCommandEnvelope[] | undefined }>;
  separateCommands?: () => Promise<RemoteCommandEnvelope[]>;
  separateClaimable?: () => Promise<unknown[]>;
}

/** The fake cloud: records every call to the website, in order. */
function fakeCloud(o: FakeOpts = {}) {
  const calls: string[] = [];
  const acks: string[] = [];
  const client = {
    consecutiveAuthFailures: 0,
    async getClaimableAndCommands() {
      calls.push("claimable+commands");
      return (o.combined ?? (async () => ({ jobs: [], commands: [] })))();
    },
    async getCommands() {
      calls.push("commands");
      return (o.separateCommands ?? (async () => []))();
    },
    async getClaimableJobs() {
      calls.push("claimable");
      return (o.separateClaimable ?? (async () => []))();
    },
    async ackCommand(id: string) {
      acks.push(id);
    },
  };
  return { client: client as unknown as CloudClient, calls, acks };
}

function fakeHealth(over: { paused?: () => boolean; heartbeat?: () => Promise<boolean> } = {}) {
  const beats: number[] = [];
  const monitor = {
    isPaused: over.paused ?? (() => false),
    adminPollSeconds: () => null,
    async sendHeartbeat() {
      beats.push(clock.t);
      return (over.heartbeat ?? (async () => true))();
    },
  };
  return { monitor, beats };
}

const clock = { t: 1_000_000 };

function build(cloud: ReturnType<typeof fakeCloud>, health: ReturnType<typeof fakeHealth>, heartbeatIntervalSeconds: number | undefined) {
  clock.t = 1_000_000;
  return createOrchestrator({
    config: { localStoragePath: dir, pollIntervalSeconds: 3, maxPollIntervalSeconds: 300, heartbeatIntervalSeconds } as never,
    cloudClient: cloud.client,
    jobQueue: createJobQueue(dir, logger),
    printerManager: {} as never,
    spoolerMonitor: {} as never,
    healthMonitor: health.monitor as never,
    logger,
    now: () => clock.t,
  });
}

/** Lets the background heartbeat (started, not awaited, by runOnce) finish. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("one call per cycle: commands ride along with the claimable jobs", () => {
  it("handles commands embedded in the claimable answer, without a separate commands call", async () => {
    const cloud = fakeCloud({ combined: async () => ({ jobs: [], commands: [cancel("c1"), cancel("c2")] }) });
    const orch = build(cloud, fakeHealth(), 30);
    expect(await orch.runOnce()).toBe("success");
    expect(cloud.calls).toEqual(["claimable+commands"]);
    expect(cloud.acks).toEqual(["c1", "c2"]);
  });

  it("an empty embedded list is a complete answer: no fallback call", async () => {
    const cloud = fakeCloud();
    const orch = build(cloud, fakeHealth(), 30);
    await orch.runOnce();
    await orch.runOnce();
    expect(cloud.calls).toEqual(["claimable+commands", "claimable+commands"]);
  });

  it("falls back to the separate commands call when the website did not include the field (older website)", async () => {
    const cloud = fakeCloud({
      combined: async () => ({ jobs: [], commands: undefined }),
      separateCommands: async () => [cancel("old1")],
    });
    const orch = build(cloud, fakeHealth(), 30);
    expect(await orch.runOnce()).toBe("success");
    expect(cloud.calls).toEqual(["claimable+commands", "commands"]);
    expect(cloud.acks).toEqual(["old1"]);
  });

  it("a failing fallback commands call counts as a partial cycle, not a total failure", async () => {
    const cloud = fakeCloud({
      combined: async () => ({ jobs: [], commands: undefined }),
      separateCommands: async () => {
        throw new CloudNetworkError("down");
      },
    });
    const orch = build(cloud, fakeHealth(), 30);
    expect(await orch.runOnce()).toBe("partial");
  });

  it("the combined call failing outright is a failure when the heartbeat is failing too, and partial while the heartbeat last worked", async () => {
    const down = async () => {
      throw new CloudNetworkError("down");
    };
    const a = build(fakeCloud({ combined: down }), fakeHealth(), 30);
    expect(await a.runOnce()).toBe("partial"); // heartbeat state still "ok": exactly as when only the jobs call used to fail

    const health = fakeHealth({ heartbeat: async () => false });
    const b = build(fakeCloud({ combined: down }), health, 30);
    await b.runOnce(); // starts the (failing) heartbeat in the background
    await settle();
    expect(await b.runOnce()).toBe("failure");
  });

  it("a paused agent does not ask for jobs: it fetches its commands separately, as before, and heartbeats every cycle so a resume is noticed", async () => {
    const cloud = fakeCloud({ separateCommands: async () => [cancel("p1")] });
    const health = fakeHealth({ paused: () => true });
    const orch = build(cloud, health, 30);
    expect(await orch.runOnce()).toBe("success");
    await settle();
    clock.t += 3_000;
    await orch.runOnce();
    await settle();
    expect(cloud.calls).toEqual(["commands", "commands"]);
    expect(health.beats).toHaveLength(2);
  });
});

describe("heartbeat cadence", () => {
  it("sends one at start-up, none before the interval, then one when it is due", async () => {
    const cloud = fakeCloud();
    const health = fakeHealth();
    const orch = build(cloud, health, 30);
    await orch.runOnce();
    await settle();
    expect(health.beats).toHaveLength(1);
    for (let i = 0; i < 9; i++) {
      clock.t += 3_000; // 27 s in total
      await orch.runOnce();
      await settle();
    }
    expect(health.beats).toHaveLength(1);
    clock.t += 3_000; // 30 s
    await orch.runOnce();
    await settle();
    expect(health.beats).toHaveLength(2);
    expect(cloud.calls.filter((c) => c === "claimable+commands")).toHaveLength(11);
  });

  it("the rollback value (0) restores today's three calls every cycle, heartbeat first, awaited", async () => {
    const cloud = fakeCloud();
    const health = fakeHealth();
    const orch = build(cloud, health, 0);
    await orch.runOnce();
    clock.t += 3_000;
    await orch.runOnce();
    expect(health.beats).toHaveLength(2);
    expect(cloud.calls).toEqual(["commands", "claimable", "commands", "claimable"]);
  });

  it("a failed heartbeat is retried after 10 s, not every cycle and not only after the full interval", async () => {
    const health = fakeHealth({ heartbeat: async () => false });
    const orch = build(fakeCloud(), health, 30);
    await orch.runOnce();
    await settle();
    clock.t += 6_000;
    await orch.runOnce();
    await settle();
    expect(health.beats).toHaveLength(1);
    clock.t += 6_000; // 12 s after the failure
    await orch.runOnce();
    await settle();
    expect(health.beats).toHaveLength(2);
  });

  it("a heartbeat that throws is harmless and a hanging one neither blocks nor stacks up", async () => {
    const boom = fakeHealth({
      heartbeat: async () => {
        throw new Error("kaput");
      },
    });
    const a = build(fakeCloud(), boom, 30);
    await expect(a.runOnce()).resolves.toBeDefined();
    await settle();

    let release: (ok: boolean) => void = () => {};
    const hang = fakeHealth({ heartbeat: () => new Promise<boolean>((r) => (release = r)) });
    const cloud = fakeCloud();
    const b = build(cloud, hang, 30);
    await b.runOnce(); // heartbeat starts and never answers; the job poll still ran
    clock.t += 60_000;
    await b.runOnce();
    clock.t += 60_000;
    await b.runOnce();
    expect(cloud.calls).toEqual(["claimable+commands", "claimable+commands", "claimable+commands"]);
    expect(hang.beats).toHaveLength(1); // one in flight at a time
    release(true);
    await settle();
    clock.t += 30_000;
    await b.runOnce();
    await settle();
    expect(hang.beats).toHaveLength(2);
  });

  it("a failing heartbeat does not stop jobs being fetched on the very same cycle", async () => {
    const cloud = fakeCloud();
    const orch = build(cloud, fakeHealth({ heartbeat: async () => false }), 30);
    await orch.runOnce();
    expect(cloud.calls).toEqual(["claimable+commands"]);
  });

  it("a config without the setting (an older test config) behaves as the 30 s default", async () => {
    const health = fakeHealth();
    const orch = build(fakeCloud(), health, undefined);
    await orch.runOnce();
    await settle();
    clock.t += 3_000;
    await orch.runOnce();
    await settle();
    expect(health.beats).toHaveLength(1);
  });
});

describe("PRINTIO_HEARTBEAT_SECONDS", () => {
  it("defaults to 30, clamps to 10-120, and treats 0 or 'cycle' as every cycle", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_SECONDS).toBe(30);
    expect(parseHeartbeatSeconds(undefined)).toBe(30);
    expect(parseHeartbeatSeconds("")).toBe(30);
    expect(parseHeartbeatSeconds("45")).toBe(45);
    expect(parseHeartbeatSeconds("5")).toBe(10);
    expect(parseHeartbeatSeconds("9999")).toBe(120);
    expect(parseHeartbeatSeconds("0")).toBe(0);
    expect(parseHeartbeatSeconds("cycle")).toBe(0);
    expect(parseHeartbeatSeconds(" Cycle ")).toBe(0);
  });

  it("a typo never stops the service starting: it means the default", () => {
    expect(parseHeartbeatSeconds("fast")).toBe(30);
    expect(parseHeartbeatSeconds("-3")).toBe(30);
    expect(parseHeartbeatSeconds("2.5")).toBe(30);
  });

  it("loadConfig reads it", () => {
    const base = { PRINTIO_API_URL: "https://printio.example.org" } as NodeJS.ProcessEnv;
    expect(loadConfig({ env: base }).heartbeatIntervalSeconds).toBe(30);
    expect(loadConfig({ env: { ...base, PRINTIO_HEARTBEAT_SECONDS: "0" } }).heartbeatIntervalSeconds).toBe(0);
  });
});

describe("CloudClient.getClaimableAndCommands (new agent, old and new website)", () => {
  function clientFor(body: unknown) {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new CloudClient({ apiUrl: "https://cloud.example", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    return { client, urls };
  }

  it("asks with ?commands=1 and returns both lists from a new website", async () => {
    const { client, urls } = clientFor({ jobs: [{ jobId: "j1", printerProfileId: "p", jobNumber: "JOB-1" }], commands: [cancel("c1")] });
    const res = await client.getClaimableAndCommands();
    expect(urls).toEqual(["https://cloud.example/api/agents/jobs/claimable?commands=1"]);
    expect(res.jobs).toHaveLength(1);
    expect(res.commands).toEqual([cancel("c1")]);
  });

  it("an old website (field absent, or not a list) gives commands undefined and the jobs untouched", async () => {
    const old = clientFor({ jobs: [{ jobId: "j1", printerProfileId: "p", jobNumber: "JOB-1" }] });
    expect((await old.client.getClaimableAndCommands()).commands).toBeUndefined();
    const odd = clientFor({ jobs: [], commands: "nope" });
    expect((await odd.client.getClaimableAndCommands()).commands).toBeUndefined();
  });

  it("counts auth failures like the other polls (a revoked agent still slows itself down)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "no" } }), { status: 401 }));
    const client = new CloudClient({ apiUrl: "https://cloud.example", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getClaimableAndCommands()).rejects.toBeInstanceOf(CloudApiError);
    expect(client.consecutiveAuthFailures).toBe(1);
  });
});
