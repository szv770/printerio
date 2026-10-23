// Idempotency for phone retries (owner decision 2026-10-23): the same device sending the same document (same
// options) again within a few minutes gets the PREVIOUS result back instead of creating another print job.
//  - Keyed BEFORE the web call, so a retry that arrives while the first request is still being processed (the
//    phone gave up waiting) joins the same in-flight promise rather than starting a second finalize.
//  - Only results the caller marks cacheable are remembered (a refusal or a failure is retried for real), and a
//    rejected run is forgotten at once, so a web hiccup never blocks a later retry.
//  - Entries expire (ttl) and the table is capped (LRU) so memory stays bounded. In-flight entries are never
//    evicted: dropping one would allow exactly the duplicate this exists to prevent.
//  - The cache stores only the small result (job ids/state), never the document bytes.

export const DEDUPE_TTL_MS = 3 * 60 * 1000;
export const DEDUPE_MAX_ENTRIES = 500;

interface Entry<T> {
  promise: Promise<T>;
  settled: boolean;
  value?: T;
  /** Epoch ms after which a settled entry is no longer used. */
  expiresAt: number;
}

export interface DedupeOptions<T> {
  /** Remember the result for the window? Default: yes. */
  cache?: (value: T) => boolean;
  /** A remembered result that is no longer valid (e.g. its job was cancelled) is replaced by new work. */
  usable?: (value: T) => boolean;
}

export interface DedupeCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class DedupeCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: DedupeCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEDUPE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEDUPE_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  async run(key: string, work: () => Promise<T>, opts: DedupeOptions<T> = {}): Promise<{ value: T; deduped: boolean }> {
    const existing = this.entries.get(key);
    if (existing) {
      if (!existing.settled) {
        // Same document is being processed right now: share it (all waiters see the same outcome, including a failure).
        return { value: await existing.promise, deduped: true };
      }
      const fresh = existing.expiresAt > this.now();
      if (fresh && (!opts.usable || opts.usable(existing.value as T))) {
        // Touch: most recently used goes to the end of the Map's insertion order.
        this.entries.delete(key);
        this.entries.set(key, existing);
        return { value: existing.value as T, deduped: true };
      }
      this.entries.delete(key);
    }

    const entry: Entry<T> = { promise: undefined as unknown as Promise<T>, settled: false, expiresAt: Number.POSITIVE_INFINITY };
    entry.promise = (async () => {
      try {
        const value = await work();
        entry.settled = true;
        entry.value = value;
        entry.expiresAt = this.now() + this.ttlMs;
        if (opts.cache && !opts.cache(value)) this.drop(key, entry);
        return value;
      } catch (err) {
        this.drop(key, entry);
        throw err;
      }
    })();
    this.entries.set(key, entry);
    this.evict();
    return { value: await entry.promise, deduped: false };
  }

  /** Forgets every settled entry whose value matches (used when a job is cancelled). */
  invalidate(match: (value: T) => boolean): void {
    for (const [key, e] of this.entries) {
      if (e.settled && match(e.value as T)) this.entries.delete(key);
    }
  }

  private drop(key: string, entry: Entry<T>): void {
    // Only remove our own entry: a newer run for the same key must not be forgotten by an older one finishing late.
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const t = this.now();
    for (const [key, e] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (e.settled && e.expiresAt <= t) this.entries.delete(key);
    }
    for (const [key, e] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (e.settled) this.entries.delete(key);
    }
  }
}
