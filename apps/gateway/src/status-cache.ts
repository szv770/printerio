// Android polls Get-Job-Attributes about once a second per job. Ten phones must not become ten web requests per
// second, so each job's web status is remembered for ~3 seconds (keyed by the web job id), and concurrent polls for
// the same job share one in-flight request. Terminal states never reach this (handlers.refreshState skips them).
// A cancel invalidates the entry, and an answer that was already in flight when the job was cancelled is discarded
// rather than written back (it would resurrect the pre-cancel state).
import type { JobInfo } from "./web-client.js";

export const STATUS_TTL_MS = 3000;
export const STATUS_MAX_ENTRIES = 2000;

interface Settled {
  info: JobInfo | null;
  expiresAt: number;
}
interface Inflight {
  promise: Promise<JobInfo | null>;
  invalidated: boolean;
}

export interface StatusCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class StatusCache {
  private readonly settled = new Map<string, Settled>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: StatusCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? STATUS_TTL_MS;
    this.maxEntries = opts.maxEntries ?? STATUS_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.settled.size;
  }

  /** The last remembered answer, fresh or not (undefined when none). Used to see that a job is known to be dead. */
  peek(webJobId: string): JobInfo | null | undefined {
    return this.settled.get(webJobId)?.info;
  }

  async get(webJobId: string, fetcher: () => Promise<JobInfo | null>): Promise<JobInfo | null> {
    const hit = this.settled.get(webJobId);
    if (hit && hit.expiresAt > this.now()) return hit.info;

    const running = this.inflight.get(webJobId);
    if (running) return running.promise;

    const flight: Inflight = { promise: undefined as unknown as Promise<JobInfo | null>, invalidated: false };
    flight.promise = (async () => {
      try {
        const info = await fetcher();
        if (!flight.invalidated) this.store(webJobId, info);
        return info;
      } finally {
        if (this.inflight.get(webJobId) === flight) this.inflight.delete(webJobId);
      }
    })();
    this.inflight.set(webJobId, flight);
    return flight.promise;
  }

  /** Seed with a fresh answer (the finalize reply), so the first poll right after submitting is free. */
  prime(webJobId: string, info: JobInfo): void {
    this.store(webJobId, info);
  }

  invalidate(webJobId: string): void {
    this.settled.delete(webJobId);
    const running = this.inflight.get(webJobId);
    if (running) {
      running.invalidated = true;
      this.inflight.delete(webJobId);
    }
  }

  private store(webJobId: string, info: JobInfo | null): void {
    this.settled.delete(webJobId);
    this.settled.set(webJobId, { info, expiresAt: this.now() + this.ttlMs });
    if (this.settled.size <= this.maxEntries) return;
    const t = this.now();
    for (const [key, e] of this.settled) {
      if (this.settled.size <= this.maxEntries) return;
      if (e.expiresAt <= t) this.settled.delete(key);
    }
    for (const key of this.settled.keys()) {
      if (this.settled.size <= this.maxEntries) return;
      this.settled.delete(key);
    }
  }
}
