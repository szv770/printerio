// In-memory, per-device record of IPP jobs this process has handed out.
//  - Create-Job entries wait for Send-Document ("awaiting"); they expire after 10 minutes (contract).
//  - Submitted entries map the IPP job-id the client knows to the web job id, so Get-Job-Attributes /
//    Cancel-Job work. They are lost on a gateway restart (clients then get client-error-not-found).
import type { JobState } from "@printio/shared";
import type { FlatObject } from "./ipp/codec.js";

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const SUBMITTED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DEVICE = 200;
/** Create-Job ids live far above any realistic web job number so they never collide with them. */
const PENDING_ID_BASE = 1_000_000_000;

export interface JobEntry {
  ippId: number;
  name: string;
  userName: string;
  createdAt: number;
  expiresAt: number;
  /** Job-template attributes from Create-Job / Print-Job (flattened). */
  attributes: FlatObject;
  webJobId?: string;
  /** Last state seen from the web app; undefined while awaiting the document. */
  state?: JobState;
  message?: string;
  bytes: number;
}

export class JobRegistry {
  private readonly byDevice = new Map<string, Map<number, JobEntry>>();
  private nextPendingId = PENDING_ID_BASE;

  constructor(private readonly now: () => number = Date.now) {}

  private devMap(deviceId: string): Map<number, JobEntry> {
    let m = this.byDevice.get(deviceId);
    if (!m) {
      m = new Map();
      this.byDevice.set(deviceId, m);
    }
    return m;
  }

  createPending(deviceId: string, init: { name: string; userName: string; attributes: FlatObject }): JobEntry {
    this.sweep();
    const m = this.devMap(deviceId);
    while (m.size >= MAX_PER_DEVICE) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    const t = this.now();
    const entry: JobEntry = {
      ippId: this.nextPendingId++,
      name: init.name,
      userName: init.userName,
      createdAt: t,
      expiresAt: t + PENDING_TTL_MS,
      attributes: init.attributes,
      bytes: 0,
    };
    m.set(entry.ippId, entry);
    return entry;
  }

  /** Records a job the web app created for this device (Print-Job, or a Create-Job entry after Send-Document). */
  markSubmitted(
    deviceId: string,
    entry: JobEntry | null,
    web: { ippId: number; webJobId: string; state: JobState; message?: string; bytes: number },
    init: { name: string; userName: string; attributes: FlatObject },
  ): JobEntry {
    const m = this.devMap(deviceId);
    const t = this.now();
    const e: JobEntry = entry ?? {
      ippId: web.ippId,
      name: init.name,
      userName: init.userName,
      createdAt: t,
      expiresAt: 0,
      attributes: init.attributes,
      bytes: 0,
    };
    e.webJobId = web.webJobId;
    e.state = web.state;
    e.message = web.message;
    e.bytes = web.bytes;
    e.expiresAt = t + SUBMITTED_TTL_MS;
    m.set(e.ippId, e);
    return e;
  }

  get(deviceId: string, ippId: number): JobEntry | undefined {
    const m = this.byDevice.get(deviceId);
    const e = m?.get(ippId);
    if (!m || !e) return undefined;
    if (e.expiresAt <= this.now()) {
      m.delete(ippId);
      return undefined;
    }
    return e;
  }

  remove(deviceId: string, ippId: number): void {
    this.byDevice.get(deviceId)?.delete(ippId);
  }

  list(deviceId: string): JobEntry[] {
    this.sweep();
    return [...(this.byDevice.get(deviceId)?.values() ?? [])];
  }

  sweep(): void {
    const t = this.now();
    for (const [dev, m] of this.byDevice) {
      for (const [id, e] of m) if (e.expiresAt <= t) m.delete(id);
      if (m.size === 0) this.byDevice.delete(dev);
    }
  }
}
