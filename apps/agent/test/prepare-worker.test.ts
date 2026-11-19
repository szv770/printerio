import { describe, expect, it, vi, type Mock } from "vitest";
import { CloudApiError, CloudNetworkError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import {
  AFTER_JOB_MS,
  createPrepareWorker,
  IDLE_MS,
  MAX_BACKOFF_MS,
  startPrepareWorker,
  type PrepareCloud,
  type PrepareOutcome,
  type PreparePipeline,
} from "../src/prepare-worker.js";

const JOB = { jobId: "job-1", params: { choices: { sides: "one" } }, leaseSeconds: 120 };
const SLOT = { path: "prepared/org/job-1/abc.pdf", uploadUrl: "https://storage.test/object/upload/sign/print-jobs/prepared/org/job-1/abc.pdf?token=t", apikey: "public-key" };
const ORIGINAL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
const PREPARED = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9]);

function makeLogger() {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: l as unknown as Logger, l };
}

function makeCloud(over: Partial<PrepareCloud> = {}) {
  const calls: string[] = [];
  const cloud = {
    claimPrepareJob: vi.fn(async () => (calls.push("claim"), JOB as typeof JOB | null)),
    getPrepareOriginalUrl: vi.fn(async () => (calls.push("original"), "https://storage.test/original.pdf")),
    getPrepareUploadSlot: vi.fn(async () => (calls.push("slot"), SLOT)),
    renewPrepareJob: vi.fn(async () => void calls.push("renew")),
    completePrepareJob: vi.fn(async () => void calls.push("complete")),
    failPrepareJob: vi.fn(async () => void calls.push("fail")),
    ...over,
  };
  return { cloud: cloud as unknown as PrepareCloud & typeof cloud, calls };
}

function makeFetch(over: { download?: Response | (() => Response); uploadStatus?: number } = {}) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (init?.method === "PUT") return new Response(null, { status: over.uploadStatus ?? 200 });
    const d = over.download;
    return typeof d === "function" ? d() : (d ?? new Response(ORIGINAL, { status: 200 }));
  });
  return { impl: impl as unknown as typeof fetch, seen };
}

const prepared = (over: Partial<Extract<PrepareOutcome, { kind: "prepared" }>> = {}): PrepareOutcome => ({
  kind: "prepared",
  bytes: PREPARED,
  result: { sourcePages: 5, bookletPaddingAdded: 0, flags: [], fidelity: "same" },
  ...over,
});

function worker(opts: { cloud?: ReturnType<typeof makeCloud>["cloud"]; pipeline?: PreparePipeline; fetch?: typeof fetch; timeoutMs?: number; renewEveryMs?: number; maxOriginalBytes?: number } = {}) {
  const { logger, l } = makeLogger();
  const c = opts.cloud ?? makeCloud().cloud;
  const w = createPrepareWorker({
    cloud: c,
    pipeline: opts.pipeline ?? (async () => prepared()),
    logger,
    fetchImpl: opts.fetch ?? makeFetch().impl,
    jobTimeoutMs: opts.timeoutMs ?? 5_000,
    renewEveryMs: opts.renewEveryMs ?? 60_000,
    maxOriginalBytes: opts.maxOriginalBytes,
  });
  return { w, c, l };
}

const abortable = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
const mockOf = (fn: unknown) => fn as Mock;
const cancelled = () => new CloudApiError("cancelled", "cancelled", 409);

describe("prepare worker: a job from claim to complete", () => {
  it("does nothing when no job is waiting", async () => {
    const pipeline = vi.fn(async () => prepared());
    const { w, c } = worker({ pipeline, cloud: makeCloud({ claimPrepareJob: vi.fn(async () => null) }).cloud });
    expect(await w.tick()).toBe(IDLE_MS);
    expect(c.getPrepareOriginalUrl).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("claims, downloads the original, prepares it, uploads to the slot the website chose, and completes", async () => {
    const c = makeCloud();
    const f = makeFetch();
    const pipeline = vi.fn(async () => prepared());
    const { w } = worker({ cloud: c.cloud, fetch: f.impl, pipeline });
    expect(await w.tick()).toBe(AFTER_JOB_MS);

    expect(c.calls).toEqual(["claim", "original", "slot", "complete"]);
    expect(pipeline).toHaveBeenCalledOnce();
    const input = (pipeline.mock.calls[0] as unknown as [{ original: Uint8Array; params: unknown }])[0];
    expect(Array.from(input.original)).toEqual(Array.from(ORIGINAL));
    expect(input.params).toEqual(JOB.params);

    const [get, put] = f.seen;
    expect(get!.url).toBe("https://storage.test/original.pdf");
    expect(put!.url).toBe(SLOT.uploadUrl);
    expect(put!.init?.method).toBe("PUT");
    expect(put!.init?.headers).toMatchObject({ apikey: "public-key", "content-type": "application/pdf", "x-upsert": "false" });
    expect(Array.from(put!.init?.body as Uint8Array)).toEqual(Array.from(PREPARED));
    expect(c.cloud.completePrepareJob).toHaveBeenCalledWith("job-1", { sourcePages: 5, bookletPaddingAdded: 0, flags: [], fidelity: "same", preparedPath: SLOT.path });
    expect(c.cloud.failPrepareJob).not.toHaveBeenCalled();
  });

  it("'print the original as it is' needs no upload slot", async () => {
    const c = makeCloud();
    const { w } = worker({ cloud: c.cloud, pipeline: async () => prepared({ bytes: null }) });
    await w.tick();
    expect(c.calls).toEqual(["claim", "original", "complete"]);
    expect(c.cloud.completePrepareJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ preparedPath: null }));
  });

  it("a file that cannot be printed is reported as a plain reason, with no upload", async () => {
    const c = makeCloud();
    const { w } = worker({ cloud: c.cloud, pipeline: async () => ({ kind: "rejected", reason: "This PDF is password protected.", sourcePages: 0 }) });
    await w.tick();
    expect(c.calls).toEqual(["claim", "original", "complete"]);
    expect(c.cloud.completePrepareJob).toHaveBeenCalledWith("job-1", { preparedPath: null, sourcePages: 0, rejectedReason: "This PDF is password protected." });
  });
});

describe("prepare worker: failures are reported in plain words, never with internals", () => {
  it("a crashing pipeline fails the job with a generic plain reason", async () => {
    const c = makeCloud();
    const { w, l } = worker({ cloud: c.cloud, pipeline: async () => { throw new Error("pdf-lib exploded on object 17 0 R at C:\\secret\\path"); } });
    expect(await w.tick()).toBe(AFTER_JOB_MS);
    expect(c.cloud.completePrepareJob).not.toHaveBeenCalled();
    const reason = mockOf(c.cloud.failPrepareJob).mock.calls[0]![1] as string;
    expect(reason).toMatch(/could not prepare this file/i);
    expect(reason).not.toMatch(/pdf-lib|secret|object 17/);
    expect(l.warn).toHaveBeenCalled(); // the real error is in the local log
  });

  it("a download error fails the job; a file over the size cap fails it as too large and the pipeline never runs", async () => {
    const pipeline = vi.fn(async () => prepared());
    const c1 = makeCloud();
    await worker({ cloud: c1.cloud, pipeline, fetch: makeFetch({ download: new Response("nope", { status: 500 }) }).impl }).w.tick();
    expect(c1.cloud.failPrepareJob).toHaveBeenCalledOnce();

    const c2 = makeCloud();
    const big = () => new Response(ORIGINAL, { status: 200, headers: { "content-length": "999999999" } });
    await worker({ cloud: c2.cloud, pipeline, fetch: makeFetch({ download: big }).impl, maxOriginalBytes: 1000 }).w.tick();
    expect(mockOf(c2.cloud.failPrepareJob).mock.calls[0]![1]).toMatch(/too large/i);

    const c3 = makeCloud();
    const noLength = () => new Response(new Uint8Array(5000), { status: 200 });
    await worker({ cloud: c3.cloud, pipeline, fetch: makeFetch({ download: noLength }).impl, maxOriginalBytes: 1000 }).w.tick();
    expect(mockOf(c3.cloud.failPrepareJob).mock.calls[0]![1]).toMatch(/too large/i);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("an upload that the storage refuses fails the job", async () => {
    const c = makeCloud();
    await worker({ cloud: c.cloud, fetch: makeFetch({ uploadStatus: 403 }).impl }).w.tick();
    expect(c.cloud.completePrepareJob).not.toHaveBeenCalled();
    expect(c.cloud.failPrepareJob).toHaveBeenCalledOnce();
  });

  it("SECONDS NOT MINUTES: a job that runs past the time limit is stopped and fails with a plain 'took too long' reason", async () => {
    const c = makeCloud();
    let seenSignal: AbortSignal | undefined;
    const { w } = worker({
      cloud: c.cloud,
      timeoutMs: 30,
      pipeline: async ({ signal }) => {
        seenSignal = signal;
        return abortable(signal);
      },
    });
    const started = Date.now();
    await w.tick();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seenSignal?.aborted).toBe(true);
    expect(mockOf(c.cloud.failPrepareJob).mock.calls[0]![1]).toMatch(/took too long/i);
    expect(c.cloud.completePrepareJob).not.toHaveBeenCalled();
  });

  it("if even the failure report cannot be sent, it is logged and nothing is thrown", async () => {
    const c = makeCloud({ failPrepareJob: vi.fn(async () => { throw new CloudNetworkError("offline"); }) });
    const { w, l } = worker({ cloud: c.cloud, pipeline: async () => { throw new Error("x"); } });
    await expect(w.tick()).resolves.toBe(AFTER_JOB_MS);
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("could not report a failed prepare job"), expect.anything());
  });
});

describe("prepare worker: the sender cancels (it takes really fast to go, so every step must cope)", () => {
  it("cancelled while the pipeline is working (seen on a lease renewal): the work is dropped, nothing more is sent", async () => {
    const c = makeCloud({ renewPrepareJob: vi.fn(async () => { throw cancelled(); }) });
    let signal: AbortSignal | undefined;
    const { w } = worker({ cloud: c.cloud, renewEveryMs: 10, pipeline: async (i) => { signal = i.signal; return abortable(i.signal); } });
    await w.tick();
    expect(signal?.aborted).toBe(true);
    expect(c.cloud.failPrepareJob).not.toHaveBeenCalled();
    expect(c.cloud.completePrepareJob).not.toHaveBeenCalled();
    expect(c.cloud.getPrepareUploadSlot).not.toHaveBeenCalled();
  });

  it("cancelled right at the end (the website answers 409 cancelled to complete): dropped silently, no failure report", async () => {
    const c = makeCloud({ completePrepareJob: vi.fn(async () => { throw cancelled(); }) });
    const { w } = worker({ cloud: c.cloud });
    await expect(w.tick()).resolves.toBe(AFTER_JOB_MS);
    expect(c.cloud.failPrepareJob).not.toHaveBeenCalled();
  });

  it("cancelled before the file is even fetched, or while asking for the upload slot: dropped at once", async () => {
    const c1 = makeCloud({ getPrepareOriginalUrl: vi.fn(async () => { throw cancelled(); }) });
    const pipeline = vi.fn(async () => prepared());
    await worker({ cloud: c1.cloud, pipeline }).w.tick();
    expect(pipeline).not.toHaveBeenCalled();
    expect(c1.cloud.failPrepareJob).not.toHaveBeenCalled();

    const c2 = makeCloud({ getPrepareUploadSlot: vi.fn(async () => { throw cancelled(); }) });
    const f = makeFetch();
    await worker({ cloud: c2.cloud, fetch: f.impl }).w.tick();
    expect(f.seen.some((s) => s.init?.method === "PUT")).toBe(false); // nothing uploaded
    expect(c2.cloud.completePrepareJob).not.toHaveBeenCalled();
    expect(c2.cloud.failPrepareJob).not.toHaveBeenCalled();
  });

  it("a lost lease (403 or 404) is treated the same way: another server owns the job now", async () => {
    for (const status of [403, 404]) {
      const c = makeCloud({ getPrepareOriginalUrl: vi.fn(async () => { throw new CloudApiError("gone", "no_lease", status); }) });
      await worker({ cloud: c.cloud }).w.tick();
      expect(c.cloud.failPrepareJob).not.toHaveBeenCalled();
    }
  });

  it("a renewal that fails only because the network blipped does not stop the work", async () => {
    const c = makeCloud({ renewPrepareJob: vi.fn(async () => { throw new CloudNetworkError("blip"); }) });
    const { w } = worker({ cloud: c.cloud, renewEveryMs: 5, pipeline: async () => { await new Promise((r) => setTimeout(r, 40)); return prepared(); } });
    await w.tick();
    expect(mockOf(c.cloud.renewPrepareJob).mock.calls.length).toBeGreaterThan(1);
    expect(c.cloud.completePrepareJob).toHaveBeenCalledOnce();
  });

  it("stopping the agent while a job runs drops it quietly", async () => {
    const c = makeCloud();
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const { w } = worker({ cloud: c.cloud, pipeline: async ({ signal }) => { started(); return abortable(signal); } });
    const tick = w.tick();
    await running;
    w.stop();
    await tick;
    expect(c.cloud.failPrepareJob).not.toHaveBeenCalled();
    expect(c.cloud.completePrepareJob).not.toHaveBeenCalled();
  });
});

describe("prepare worker: it can never get in the way of printing", () => {
  it("claim errors back off (doubling, capped), never throw, and a good claim resets the backoff", async () => {
    let fail = true;
    const c = makeCloud({ claimPrepareJob: vi.fn(async () => { if (fail) throw new CloudApiError("no", "forbidden", 403); return null; }) });
    const { w } = worker({ cloud: c.cloud });
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) delays.push(await w.tick());
    expect(delays[0]).toBe(IDLE_MS * 2);
    expect(delays[1]).toBe(IDLE_MS * 4);
    expect(Math.max(...delays)).toBe(MAX_BACKOFF_MS);
    fail = false;
    expect(await w.tick()).toBe(IDLE_MS);
  });

  it("a network error on claim is just a backoff", async () => {
    const c = makeCloud({ claimPrepareJob: vi.fn(async () => { throw new CloudNetworkError("down"); }) });
    await expect(worker({ cloud: c.cloud }).w.tick()).resolves.toBeGreaterThan(IDLE_MS);
  });

  it("one job at a time: a second tick while one is running does not claim another", async () => {
    const c = makeCloud();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { w } = worker({ cloud: c.cloud, pipeline: async () => { await gate; return prepared(); } });
    const first = w.tick();
    await new Promise((r) => setTimeout(r, 10));
    await w.tick();
    expect(c.cloud.claimPrepareJob).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("a logger that throws cannot make anything throw", async () => {
    const bad = { debug: () => { throw new Error("log"); }, info: () => { throw new Error("log"); }, warn: () => { throw new Error("log"); }, error: () => { throw new Error("log"); } } as unknown as Logger;
    const w = createPrepareWorker({ cloud: makeCloud().cloud, pipeline: async () => { throw new Error("x"); }, logger: bad, fetchImpl: makeFetch().impl, jobTimeoutMs: 1000 });
    await expect(w.tick()).resolves.toBe(AFTER_JOB_MS);
  });

  it("stop() is safe to call repeatedly and a stopped worker does nothing", async () => {
    const c = makeCloud();
    const { w } = worker({ cloud: c.cloud });
    w.stop();
    w.stop();
    expect(await w.tick()).toBe(IDLE_MS);
    expect(c.cloud.claimPrepareJob).not.toHaveBeenCalled();
  });
});

describe("startPrepareWorker (the entry point the agent calls)", () => {
  const base = () => ({ cloud: makeCloud().cloud, logger: makeLogger().logger });
  it("is off by default: nothing is created", () => {
    expect(startPrepareWorker({ ...base(), enabled: false, pipeline: async () => prepared() })).toBeNull();
  });
  it("on but without a PDF pipeline it stays off and says why (a server must never claim a job it cannot prepare)", () => {
    const { logger, l } = makeLogger();
    expect(startPrepareWorker({ cloud: makeCloud().cloud, logger, enabled: true })).toBeNull();
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("no PDF pipeline"));
  });
  it("on with a pipeline it starts and can be stopped", () => {
    const w = startPrepareWorker({ ...base(), enabled: true, pipeline: async () => prepared() });
    expect(w).not.toBeNull();
    w!.stop();
  });
});
