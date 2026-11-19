import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { createPrepareHint, createPrepareWorker, HINT_FRESH_MS, IDLE_MS, type PrepareCloud, type PrepareOutcome } from "../src/prepare-worker.js";

const logger = createLogger({ level: "error" });
const JOB = { jobId: "job-1", params: {}, leaseSeconds: 120 };
const SLOT = { path: "prepared/org/job-1/a.pdf", uploadUrl: "https://storage.test/up", apikey: "k" };
const prepared = (): PrepareOutcome => ({ kind: "prepared", bytes: null, result: { sourcePages: 1 } });

describe("createPrepareHint", () => {
  it("knows nothing at first, then believes the latest answer for a while, then forgets", () => {
    let t = 0;
    const h = createPrepareHint(() => t);
    expect(h.read()).toBeNull();
    h.set(true);
    expect(h.read()).toBe(true);
    h.set(false);
    expect(h.read()).toBe(false);
    t += HINT_FRESH_MS + 1;
    expect(h.read()).toBeNull();
  });
  it("tells listeners only when it turns to 'waiting' (not on every repeat, not on false)", () => {
    const h = createPrepareHint();
    const fn = vi.fn();
    h.subscribe(fn);
    h.set(false);
    h.set(true);
    h.set(true);
    expect(fn).toHaveBeenCalledTimes(1);
    h.set(false);
    h.set(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("a listener that throws never breaks the poll that set the hint", () => {
    const h = createPrepareHint();
    h.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => h.set(true)).not.toThrow();
  });
});

function makeWorker(hint: ReturnType<typeof createPrepareHint> | undefined, claim: () => Promise<typeof JOB | null>) {
  const calls: string[] = [];
  const cloud = {
    claimPrepareJob: vi.fn(async () => (calls.push("claim"), claim())),
    getPrepareOriginalUrl: vi.fn(async () => "https://storage.test/o.pdf"),
    getPrepareUploadSlot: vi.fn(async () => SLOT),
    renewPrepareJob: vi.fn(async () => undefined),
    completePrepareJob: vi.fn(async () => void calls.push("complete")),
    failPrepareJob: vi.fn(async () => undefined),
  } as unknown as PrepareCloud & { claimPrepareJob: ReturnType<typeof vi.fn> };
  const fetchImpl = (async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]))) as unknown as typeof fetch;
  const worker = createPrepareWorker({ cloud, pipeline: async () => prepared(), logger, fetchImpl, ...(hint ? { hint } : {}) });
  return { worker, cloud, calls };
}

describe("the prepare worker follows the website's hint", () => {
  it("a fresh 'nothing waiting' means no call to the website at all", async () => {
    const h = createPrepareHint();
    h.set(false);
    const { worker, cloud } = makeWorker(h, async () => JOB);
    expect(await worker.tick()).toBe(IDLE_MS);
    expect(cloud.claimPrepareJob).not.toHaveBeenCalled();
  });
  it("a fresh 'waiting' claims and handles the job", async () => {
    const h = createPrepareHint();
    h.set(true);
    const { worker, calls } = makeWorker(h, async () => JOB);
    await worker.tick();
    expect(calls).toEqual(["claim", "complete"]);
  });
  it("no hint, or a stale one, falls back to asking by itself (an older website never sends the field)", async () => {
    const none = makeWorker(undefined, async () => null);
    await none.worker.tick();
    expect(none.cloud.claimPrepareJob).toHaveBeenCalledTimes(1);

    let t = 0;
    const h = createPrepareHint(() => t);
    h.set(false);
    t += HINT_FRESH_MS + 1;
    const stale = makeWorker(h, async () => null);
    await stale.worker.tick();
    expect(stale.cloud.claimPrepareJob).toHaveBeenCalledTimes(1);
  });
  it("when a claim finds nothing the hint drops to false, so it does not ask again until the next poll says so", async () => {
    const h = createPrepareHint();
    h.set(true);
    const { worker, cloud } = makeWorker(h, async () => null);
    await worker.tick();
    expect(h.read()).toBe(false);
    await worker.tick();
    expect(cloud.claimPrepareJob).toHaveBeenCalledTimes(1);
  });
  describe("starting a look the moment a job is waiting", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it("a hint turning true makes the worker look right away instead of waiting for its start-up delay", async () => {
      const h = createPrepareHint();
      h.set(false);
      const { worker, cloud } = makeWorker(h, async () => null);
      worker.start();
      await vi.advanceTimersByTimeAsync(1_000); // still inside the 5 s start-up delay
      expect(cloud.claimPrepareJob).not.toHaveBeenCalled();
      h.set(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(cloud.claimPrepareJob).toHaveBeenCalledTimes(1);
      worker.stop();
    });
  });
});

describe("CloudClient asks about prepare jobs only when told to", () => {
  const make = (answer: unknown) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
    const c = new CloudClient({ apiUrl: "https://cloud.test", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    return { c, urlOf: () => String((fetchImpl.mock.calls[0] as unknown as [string])[0]) };
  };
  it("without the option the call is exactly what it was", async () => {
    const m = make({ jobs: [], commands: [] });
    expect(await m.c.getClaimableAndCommands()).toEqual({ jobs: [], commands: [] });
    expect(m.urlOf()).toBe("https://cloud.test/api/agents/jobs/claimable?commands=1");
  });
  it("with the option it adds prepare=1 and returns the answer; a missing or odd field is simply not there", async () => {
    const yes = make({ jobs: [], commands: [], prepareWaiting: true });
    expect(await yes.c.getClaimableAndCommands({ prepare: true })).toEqual({ jobs: [], commands: [], prepareWaiting: true });
    expect(yes.urlOf()).toBe("https://cloud.test/api/agents/jobs/claimable?commands=1&prepare=1");
    expect((await make({ jobs: [], commands: [] }).c.getClaimableAndCommands({ prepare: true })).prepareWaiting).toBeUndefined();
    expect((await make({ jobs: [], commands: [], prepareWaiting: "yes" }).c.getClaimableAndCommands({ prepare: true })).prepareWaiting).toBeUndefined();
  });
});

describe("the print loop records the website's answer in the hint", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "printio-hint-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function orch(answer: { jobs: unknown[]; commands: unknown[]; prepareWaiting?: boolean }, withHint: boolean) {
    const asked: unknown[] = [];
    const cloud = {
      consecutiveAuthFailures: 0,
      async getClaimableAndCommands(opts?: unknown) {
        asked.push(opts);
        return answer;
      },
    };
    const hint = { set: vi.fn() };
    const o = createOrchestrator({
      config: { localStoragePath: dir, pollIntervalSeconds: 3, maxPollIntervalSeconds: 300, heartbeatIntervalSeconds: 30 } as never,
      cloudClient: cloud as unknown as CloudClient,
      jobQueue: createJobQueue(dir, logger),
      printerManager: {} as never,
      spoolerMonitor: {} as never,
      healthMonitor: { isPaused: () => false, adminPollSeconds: () => null, sendHeartbeat: async () => true } as never,
      logger,
      ...(withHint ? { prepareHint: hint } : {}),
    });
    return { o, asked, hint };
  }

  it("asks for the hint and stores it when the worker is on", async () => {
    const { o, asked, hint } = orch({ jobs: [], commands: [], prepareWaiting: true }, true);
    await o.runOnce();
    expect(asked[0]).toEqual({ prepare: true });
    expect(hint.set).toHaveBeenCalledWith(true);
  });
  it("an answer without the field leaves the hint alone (an older website)", async () => {
    const { o, hint } = orch({ jobs: [], commands: [] }, true);
    await o.runOnce();
    expect(hint.set).not.toHaveBeenCalled();
  });
  it("with the worker off the call is the one it always was", async () => {
    const { o, asked } = orch({ jobs: [], commands: [], prepareWaiting: true }, false);
    await o.runOnce();
    expect(asked[0]).toEqual({});
  });
});
