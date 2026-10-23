// Busy guard: several teachers print at once and every upload is held in memory until it has been stored and
// finalized, so the total of in-flight upload bytes is capped (default 150 MB, env MAX_INFLIGHT_UPLOAD_MB) and one
// device may have at most 2 uploads in flight (MAX_UPLOADS_PER_DEVICE). Over either limit the caller answers IPP
// server-error-busy (0x0507) and the phone retries a moment later.
//
// A Lease is taken when an upload starts and MUST be released when it ends, however it ends (success, error, client
// abort). release() is idempotent and returns exactly what the lease holds, so the counters cannot go negative or
// leak. A reservation that would break the byte cap kills the lease (its bytes are given back at once).

export const DEFAULT_MAX_INFLIGHT_BYTES = 150 * 1024 * 1024;
export const DEFAULT_MAX_UPLOADS_PER_DEVICE = 2;

export interface UploadGuardOptions {
  maxInflightBytes?: number;
  maxPerKey?: number;
}

export class UploadLease {
  private bytes = 0;
  private done = false;
  private dead = false;

  constructor(
    private readonly guard: UploadGuard,
    readonly key: string,
  ) {}

  /** Adds `n` bytes to this upload's reservation. False (and the lease's bytes are returned) when the cap would be exceeded. */
  reserve(n: number): boolean {
    if (this.done || this.dead) return false;
    if (!this.guard._reserve(this, n)) {
      this.guard._giveBack(this.bytes);
      this.bytes = 0;
      this.dead = true;
      return false;
    }
    this.bytes += n;
    return true;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Idempotent. */
  release(): void {
    if (this.done) return;
    this.done = true;
    this.guard._giveBack(this.bytes);
    this.bytes = 0;
    this.guard._freeSlot(this.key);
  }
}

export class UploadGuard {
  readonly maxInflightBytes: number;
  readonly maxPerKey: number;
  private bytes = 0;
  private slots = 0;
  private readonly perKey = new Map<string, number>();
  peakInflightBytes = 0;
  peakPerKey = 0;

  constructor(opts: UploadGuardOptions = {}) {
    this.maxInflightBytes = opts.maxInflightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES;
    this.maxPerKey = opts.maxPerKey ?? DEFAULT_MAX_UPLOADS_PER_DEVICE;
  }

  get inflightBytes(): number {
    return this.bytes;
  }
  get activeUploads(): number {
    return this.slots;
  }
  activeFor(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  /** A lease for one more upload from `key` (a device), or null when that device already has its maximum in flight. */
  tryAcquire(key: string): UploadLease | null {
    const n = this.perKey.get(key) ?? 0;
    if (n >= this.maxPerKey) return null;
    this.perKey.set(key, n + 1);
    this.slots += 1;
    this.peakPerKey = Math.max(this.peakPerKey, n + 1);
    return new UploadLease(this, key);
  }

  /** @internal */
  _reserve(_lease: UploadLease, n: number): boolean {
    if (!(n >= 0) || this.bytes + n > this.maxInflightBytes) return false;
    this.bytes += n;
    this.peakInflightBytes = Math.max(this.peakInflightBytes, this.bytes);
    return true;
  }
  /** @internal */
  _giveBack(n: number): void {
    this.bytes = Math.max(0, this.bytes - n);
  }
  /** @internal */
  _freeSlot(key: string): void {
    const n = (this.perKey.get(key) ?? 0) - 1;
    if (n <= 0) this.perKey.delete(key);
    else this.perKey.set(key, n);
    this.slots = Math.max(0, this.slots - 1);
  }
}
