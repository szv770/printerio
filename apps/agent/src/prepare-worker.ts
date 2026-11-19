/**
 * The prepare worker (docs/PREPARE-JOBS-DESIGN.md, P1). OFF by default (PRINTIO_PREPARE_WORKER=1), and inert unless a PDF pipeline is
 * plugged in (P2): the website is moving to a host that cannot do heavy PDF work, so this print server prepares its OWN school's
 * files (preflight, sanitize, page range, booklet layout, stamp, text-fidelity check) and hands the result back.
 *
 * One job, step by step: claim (own school only) -> signed link to the original -> download -> pipeline -> upload the prepared
 * file to the slot the website chose -> complete. While it works it keeps its lease alive; if the website says the job was
 * cancelled (409) or the lease is gone, it drops everything quietly and sends nothing more.
 *
 * SPEED IS A REQUIREMENT (owner, 2026-11-19: "a few seconds is fine, a few minutes is not acceptable at all"): every job has a hard
 * time limit (default 60 s). A file that cannot be prepared in time fails with a plain reason instead of a long silent wait.
 *
 * ISOLATION from printing is the point of this file's shape (same rules as library-worker.ts):
 *  - its OWN timer and state; it imports nothing from the orchestrator, health monitor, command or print code;
 *  - never awaited by any other loop; concurrency is exactly 1;
 *  - EVERY entry point catches everything and logs through the guarded logger, so nothing can reach a caller;
 *  - its timers are `unref`'d, so it can never keep the process alive;
 *  - it uses CloudClient methods that do NOT feed `consecutiveAuthFailures`, so a refusal here can never slow printing.
 */
import { CloudApiError } from "./errors.js";
import type { Logger } from "./logger.js";

/** Look for a job this often while idle (the website will later tell the print server when one is waiting, so this can go up). */
export const IDLE_MS = 15_000;
/** First look after start (the print loop gets going first). */
export const INITIAL_DELAY_MS = 5_000;
/** After a finished job look again almost at once (more may be waiting: a burst of prints), but never in a tight loop. */
export const AFTER_JOB_MS = 500;
/** Backoff after an error talking to the cloud: starts at the idle interval, doubles, never more than this. */
export const MAX_BACKOFF_MS = 5 * 60_000;
/** Hard limit for one job from claim to complete (owner: seconds, not minutes). */
export const DEFAULT_JOB_TIMEOUT_MS = 60_000;
/** The biggest original this server will load into memory. */
export const DEFAULT_MAX_ORIGINAL_BYTES = 120 * 1024 * 1024;
/** Renew the lease at this interval (the website's lease is 120 s). */
export const RENEW_EVERY_MS = 40_000;

/** What the website needs back (mirrors `prepareResultSchema` in apps/web/lib/prepare/prepare-jobs.ts). */
export interface PrepareResultPayload {
  preparedPath: string | null;
  sourcePages: number;
  bookletPaddingAdded?: number;
  flags?: string[];
  fidelity?: "same" | "changed" | "skipped";
  rejectedReason?: string;
}

export interface PrepareJobEnvelope {
  jobId: string;
  params: unknown;
  leaseSeconds: number;
}

export interface PrepareUploadSlot {
  path: string;
  uploadUrl: string;
  apikey: string;
}

export interface PrepareCloud {
  /** null = nothing waiting (204). */
  claimPrepareJob(): Promise<PrepareJobEnvelope | null>;
  getPrepareOriginalUrl(jobId: string): Promise<string>;
  getPrepareUploadSlot(jobId: string): Promise<PrepareUploadSlot>;
  renewPrepareJob(jobId: string): Promise<void>;
  completePrepareJob(jobId: string, result: PrepareResultPayload): Promise<void>;
  failPrepareJob(jobId: string, reason: string): Promise<void>;
}

/** What the pipeline (P2) returns. `bytes: null` = print the original as it is. */
export type PrepareOutcome =
  | { kind: "prepared"; bytes: Uint8Array | null; result: Omit<PrepareResultPayload, "preparedPath" | "rejectedReason"> }
  | { kind: "rejected"; reason: string; sourcePages?: number };

export type PreparePipeline = (input: { original: Uint8Array; params: unknown; signal: AbortSignal }) => Promise<PrepareOutcome>;

export interface PrepareWorkerDeps {
  cloud: PrepareCloud;
  pipeline: PreparePipeline;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  jobTimeoutMs?: number;
  maxOriginalBytes?: number;
  idleMs?: number;
  renewEveryMs?: number;
}

export interface PrepareWorker {
  /** One look for a job and, if there is one, its whole handling. Resolves to the delay (ms) before the next look. Never throws. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
}

/** Why a job was abandoned without telling the website anything more. */
type Dropped = "cancelled" | "lease_lost" | "stopped";
class DropJob extends Error {
  constructor(readonly why: Dropped) {
    super(why);
  }
}
class TooSlow extends Error {}
class TooLarge extends Error {}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A 409 `cancelled`, or the lease being gone (403/404/409): the work must be dropped, and nothing more may be sent. */
function dropReasonFor(err: unknown): Dropped | null {
  if (!(err instanceof CloudApiError)) return null;
  if (err.status === 409 && err.code === "cancelled") return "cancelled";
  if (err.status === 403 || err.status === 404 || err.status === 409) return "lease_lost";
  return null;
}

export function createPrepareWorker(deps: PrepareWorkerDeps): PrepareWorker {
  const { cloud, pipeline, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const jobTimeoutMs = deps.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const maxBytes = deps.maxOriginalBytes ?? DEFAULT_MAX_ORIGINAL_BYTES;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const renewEveryMs = deps.renewEveryMs ?? RENEW_EVERY_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopped = false;
  let running = false;
  let backoffMs = idleMs;
  const stopController = new AbortController();

  const log = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => {
    try {
      logger[level](msg, fields);
    } catch {
      /* a throwing logger must never escape */
    }
  };

  async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`download answered ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge();
    if (!res.body) {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.length > maxBytes) throw new TooLarge();
      return all;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new TooLarge();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  async function upload(slot: PrepareUploadSlot, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const res = await fetchImpl(slot.uploadUrl, {
      method: "PUT",
      headers: { apikey: slot.apikey, "content-type": "application/pdf", "x-upsert": "false", "cache-control": "max-age=3600" },
      body: bytes as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"],
      signal,
    });
    if (!res.ok) throw new Error(`upload answered ${res.status}`);
  }

  /** The whole handling of one claimed job. Resolves when it is finished or dropped; never throws. */
  async function handle(job: PrepareJobEnvelope): Promise<void> {
    const ac = new AbortController();
    let dropped: Dropped | null = null;
    const drop = (why: Dropped) => {
      if (dropped === null) dropped = why;
      ac.abort();
    };
    const onStop = () => drop("stopped");
    if (stopController.signal.aborted) onStop();
    stopController.signal.addEventListener("abort", onStop, { once: true });

    let slow = false;
    const deadline = setTimeout(() => {
      slow = true;
      ac.abort();
    }, jobTimeoutMs);
    const renew = setInterval(() => {
      void cloud.renewPrepareJob(job.jobId).catch((err) => {
        const why = dropReasonFor(err);
        if (why) drop(why);
        else log("warn", "could not renew the lease on a prepare job (will keep working)", { jobId: job.jobId, error: errText(err) });
      });
    }, renewEveryMs);
    (deadline as { unref?: () => void }).unref?.();
    (renew as { unref?: () => void }).unref?.();

    /** Every step that talks to the website goes through here, so a cancel or a lost lease stops the work at once. */
    const call = async <T>(step: Promise<T>): Promise<T> => {
      try {
        const out = await step;
        if (dropped) throw new DropJob(dropped);
        if (slow) throw new TooSlow();
        return out;
      } catch (err) {
        const why = dropReasonFor(err);
        if (why) {
          drop(why);
          throw new DropJob(why);
        }
        throw err;
      }
    };
    const checkpoint = () => {
      if (dropped) throw new DropJob(dropped);
      if (slow) throw new TooSlow();
    };

    try {
      const url = await call(cloud.getPrepareOriginalUrl(job.jobId));
      const original = await call(download(url, ac.signal));
      checkpoint();
      const outcome = await call(pipeline({ original, params: job.params, signal: ac.signal }));
      checkpoint();

      if (outcome.kind === "rejected") {
        await call(
          cloud.completePrepareJob(job.jobId, { preparedPath: null, sourcePages: outcome.sourcePages ?? 0, rejectedReason: outcome.reason.slice(0, 300) }),
        );
        log("info", "prepare job: the file cannot be printed (reported to the sender)", { jobId: job.jobId });
        return;
      }
      let preparedPath: string | null = null;
      if (outcome.bytes) {
        const slot = await call(cloud.getPrepareUploadSlot(job.jobId));
        await call(upload(slot, outcome.bytes, ac.signal));
        preparedPath = slot.path;
      }
      await call(cloud.completePrepareJob(job.jobId, { ...outcome.result, preparedPath }));
      log("info", "prepare job done", { jobId: job.jobId, pages: outcome.result.sourcePages });
    } catch (err) {
      if (err instanceof DropJob || dropped) {
        log("info", "prepare job dropped (the sender cancelled it, the lease was lost, or the agent is stopping)", { jobId: job.jobId, why: (err instanceof DropJob ? err.why : dropped) ?? "unknown" });
        return;
      }
      let reason = "The print server could not prepare this file. Please try again, or try a different PDF.";
      if (err instanceof TooSlow || slow) {
        reason = `This file took too long to prepare (over ${Math.round(jobTimeoutMs / 1000)} seconds). Try a smaller or simpler PDF.`;
      } else if (err instanceof TooLarge) {
        reason = "This file is too large for the print server to prepare. Try a smaller PDF.";
      }
      log("warn", "prepare job failed", { jobId: job.jobId, error: errText(err) });
      try {
        await cloud.failPrepareJob(job.jobId, reason);
      } catch (failErr) {
        log("warn", "could not report a failed prepare job (the website will give it to another server when the lease runs out)", { jobId: job.jobId, error: errText(failErr) });
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(renew);
      stopController.signal.removeEventListener("abort", onStop);
    }
  }

  async function tick(): Promise<number> {
    if (stopped || running) return idleMs;
    running = true;
    try {
      let job: PrepareJobEnvelope | null;
      try {
        job = await cloud.claimPrepareJob();
      } catch (err) {
        if (err instanceof CloudApiError && (err.status === 401 || err.status === 403)) {
          log("warn", "the website refused this server's prepare claim", { status: err.status, code: err.code });
        } else {
          log("warn", "could not ask the website for a prepare job", { error: errText(err) });
        }
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        return backoffMs;
      }
      backoffMs = idleMs;
      if (!job) return idleMs;
      await handle(job);
      return AFTER_JOB_MS;
    } catch (err) {
      log("error", "unexpected error in the prepare worker", { error: errText(err) });
      return MAX_BACKOFF_MS;
    } finally {
      running = false;
    }
  }

  function schedule(ms: number): void {
    if (stopped) return;
    try {
      timer = setTimeout(() => {
        timer = undefined;
        void (async () => {
          let next = idleMs;
          try {
            next = await tick();
          } catch {
            next = MAX_BACKOFF_MS;
          }
          schedule(next);
        })().catch(() => undefined);
      }, ms);
      (timer as { unref?: () => void }).unref?.();
    } catch (err) {
      log("error", "prepare worker could not schedule its next look - it stays stopped", { error: errText(err) });
    }
  }

  return {
    tick,
    start() {
      try {
        if (started || stopped) return;
        started = true;
        schedule(INITIAL_DELAY_MS);
      } catch (err) {
        log("error", "prepare worker failed to start", { error: errText(err) });
      }
    },
    stop() {
      try {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        stopController.abort();
      } catch (err) {
        log("error", "prepare worker failed to stop cleanly", { error: errText(err) });
      }
    },
  };
}

export interface StartPrepareWorkerOptions extends Omit<PrepareWorkerDeps, "pipeline"> {
  /** `config.prepareWorker` (PRINTIO_PREPARE_WORKER is 1 or true). */
  enabled: boolean;
  /** The PDF pipeline (P2). Without it the worker does not start: a print server must never claim a job it cannot prepare. */
  pipeline?: PreparePipeline;
}

/**
 * The one entry point the agent's `start` command calls. Off, or on without a pipeline: nothing is created (no timer, no network
 * call). On: the loop is started and the handle returned so shutdown can stop it. Never throws.
 */
export function startPrepareWorker(opts: StartPrepareWorkerOptions): PrepareWorker | null {
  const { enabled, pipeline, ...deps } = opts;
  try {
    if (!enabled) {
      deps.logger.debug("prepare worker is off (set PRINTIO_PREPARE_WORKER=1 to turn it on)");
      return null;
    }
    if (!pipeline) {
      deps.logger.warn("PRINTIO_PREPARE_WORKER is on, but this build has no PDF pipeline yet, so the prepare worker stays off");
      return null;
    }
    const worker = createPrepareWorker({ ...deps, pipeline });
    worker.start();
    deps.logger.info("prepare worker started (prepares this school's PDFs for the website)");
    return worker;
  } catch (err) {
    try {
      deps.logger.error("prepare worker could not be started - continuing without it", { error: errText(err) });
    } catch {
      /* ignore */
    }
    return null;
  }
}
