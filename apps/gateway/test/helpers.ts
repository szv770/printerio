import http from "node:http";
import { generateDeviceToken, hashDeviceToken, deviceHostname } from "@printio/shared/device-token";
import type { JobState } from "@printio/shared";
import { createGatewayServer } from "../src/server.js";
import { JobRegistry } from "../src/job-registry.js";
import type { ServerLimits } from "../src/request-limits.js";
import { UploadGuard } from "../src/upload-guard.js";
import { silentLogger, type Logger } from "../src/logger.js";
import {
  attr,
  decodeIpp,
  encodeIpp,
  flatten,
  TAG,
  type IppAttr,
  type IppGroup,
  type IppMessage,
} from "../src/ipp/codec.js";
import type { IntakeStorage } from "../src/storage.js";
import {
  WebUnavailableError,
  type CancelResult,
  type FinalizeRequest,
  type FinalizeResult,
  type JobInfo,
  type ResolveResult,
  type WebApi,
} from "../src/web-client.js";

export const BASE_DOMAIN = "example.test";
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

export class FakeWeb implements WebApi {
  devices = new Map<string, ResolveResult>();
  events: { deviceId: string; type: string; userAgent?: string; detail?: Record<string, unknown> }[] = [];
  finalizeCalls: FinalizeRequest[] = [];
  resolveCalls = 0;
  cancelCalls: string[] = [];
  jobs = new Map<string, JobInfo>();
  down = false;
  finalizeDown = false;
  finalizeResult: FinalizeResult | null = null;
  /** Status the next finalize creates the job with. */
  nextStatus: JobState = "approved";
  nextMessage: string | undefined;
  cancelResult: CancelResult = { kind: "ok", status: "cancelled" };
  getJobCalls = 0;
  /** Only job lookups fail (finalize and device resolution keep working). */
  getJobDown = false;
  /** While set, finalize waits for it (lets tests hold several uploads in flight at once). */
  finalizeGate: Promise<void> | null = null;
  finalizeInFlight = 0;
  peakFinalizeInFlight = 0;
  /** Make the next finalize create the job on the "web side" and then fail (a timeout after the work was done). */
  failAfterCreating = false;
  private n = 0;

  registerDevice(token: string, deviceId = "dev-1"): void {
    this.devices.set(hashDeviceToken(token), {
      kind: "ok",
      device: { deviceId, userId: "user-1", organizationId: "org-1", displayName: "Test device" },
    });
  }

  async resolveDevice(tokenHash: string): Promise<ResolveResult> {
    this.resolveCalls++;
    if (this.down) throw new WebUnavailableError("down");
    return this.devices.get(tokenHash) ?? { kind: "unknown" };
  }
  async postEvent(e: { deviceId: string; type: string; userAgent?: string; detail?: Record<string, unknown> }): Promise<void> {
    this.events.push(e);
  }
  async finalize(req: FinalizeRequest): Promise<FinalizeResult> {
    if (this.down || this.finalizeDown) throw new WebUnavailableError("down");
    this.finalizeCalls.push(req);
    this.finalizeInFlight++;
    this.peakFinalizeInFlight = Math.max(this.peakFinalizeInFlight, this.finalizeInFlight);
    try {
      if (this.finalizeGate) await this.finalizeGate;
    } finally {
      this.finalizeInFlight--;
    }
    if (this.finalizeResult) return this.finalizeResult;
    this.n++;
    // The real web app answers with its text job number (print_jobs.job_number), not an integer.
    const job = { jobId: `web-job-${this.n}`, jobNumber: `JOB-2026-${String(40 + this.n).padStart(6, "0")}`, status: this.nextStatus, message: this.nextMessage };
    this.jobs.set(job.jobId, job);
    if (this.failAfterCreating) {
      this.failAfterCreating = false;
      throw new WebUnavailableError("timed out after creating the job");
    }
    return { kind: "ok", job };
  }
  async getJob(jobId: string): Promise<JobInfo | null> {
    this.getJobCalls++;
    if (this.getJobDown) throw new WebUnavailableError("job lookup down");
    if (this.down) throw new WebUnavailableError("down");
    return this.jobs.get(jobId) ?? null;
  }
  async cancelJob(jobId: string): Promise<CancelResult> {
    this.cancelCalls.push(jobId);
    if (this.cancelResult.kind === "ok") {
      const j = this.jobs.get(jobId);
      if (j) this.jobs.set(jobId, { ...j, status: this.cancelResult.status });
    }
    return this.cancelResult;
  }
}

export class FakeStorage implements IntakeStorage {
  uploads = new Map<string, Buffer>();
  fail = false;
  async upload(path: string, bytes: Buffer): Promise<void> {
    if (this.fail) throw new Error("boom");
    this.uploads.set(path, bytes);
  }
}

export interface Harness {
  web: FakeWeb;
  storage: FakeStorage;
  token: string;
  host: string;
  port: number;
  registry: JobRegistry;
  guard: UploadGuard;
  /** Registers another device (its own token/host/deviceId). */
  addDevice(deviceId: string): { token: string; host: string; deviceId: string };
  close(): Promise<void>;
  post(body: Buffer, opts?: PostOpts): Promise<HttpResult>;
  ipp(msg: { code: number; requestId?: number; groups: IppGroup[] }, doc?: Buffer, opts?: PostOpts): Promise<{ http: HttpResult; ipp: IppMessage }>;
}

export interface PostOpts {
  host?: string;
  path?: string;
  headers?: Record<string, string>;
  chunked?: boolean;
  method?: string;
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export async function startHarness(
  over: { maxBodyBytes?: number; now?: () => number; logger?: Logger; guard?: { maxInflightBytes?: number; maxPerKey?: number };
    limits?: Partial<ServerLimits>;
    trustedProxies?: readonly string[];
  } = {},
): Promise<Harness> {
  const web = new FakeWeb();
  const storage = new FakeStorage();
  const token = generateDeviceToken();
  web.registerDevice(token);
  const registry = new JobRegistry(over.now);
  const guard = new UploadGuard(over.guard);
  const background = new Set<Promise<unknown>>();
  const server = createGatewayServer({
    deps: { web, storage, logger: over.logger ?? silentLogger, printerName: "Printio", registry, startedAt: Date.now(), now: over.now, background },
    baseDomain: BASE_DOMAIN,
    maxBodyBytes: over.maxBodyBytes ?? 1024 * 1024,
    guard,
    limits: over.limits,
    trustedProxies: over.trustedProxies,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const host = deviceHostname(token, BASE_DOMAIN);

  const post = (body: Buffer, opts: PostOpts = {}): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: opts.method ?? "POST",
          path: opts.path ?? "/ipp/print",
          headers: {
            host: opts.host ?? host,
            "content-type": "application/ipp",
            "user-agent": "test-client",
            ...(opts.chunked ? {} : { "content-length": String(body.length) }),
            ...opts.headers,
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
        },
      );
      req.on("error", reject);
      if (opts.chunked) {
        const mid = Math.floor(body.length / 2);
        req.write(body.subarray(0, mid));
        setTimeout(() => {
          req.write(body.subarray(mid));
          req.end();
        }, 5);
      } else {
        req.end(body);
      }
    });

  let reqId = 0;
  return {
    web,
    storage,
    token,
    host,
    port,
    registry,
    guard,
    addDevice(deviceId) {
      const t = generateDeviceToken();
      web.registerDevice(t, deviceId);
      return { token: t, host: deviceHostname(t, BASE_DOMAIN), deviceId };
    },
    async close() {
      await Promise.allSettled([...background]);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
    post,
    async ipp(msg, doc = Buffer.alloc(0), opts) {
      const res = await post(Buffer.concat([encodeIpp({ ...msg, requestId: msg.requestId ?? ++reqId }), doc]), opts);
      return { http: res, ipp: decodeIpp(res.body) };
    },
  };
}

export const opHead = (): IppAttr[] => [
  attr(TAG.charset, "attributes-charset", "utf-8"),
  attr(TAG.language, "attributes-natural-language", "en-us"),
];

export const operationGroup = (...extra: IppAttr[]): IppGroup => ({ tag: TAG.operation, attrs: [...opHead(), ...extra] });
export const jobGroup = (...attrs: IppAttr[]): IppGroup => ({ tag: TAG.job, attrs });

export const flatGroup = (m: IppMessage, tag: number): ReturnType<typeof flatten> =>
  flatten(m.groups.find((g) => g.tag === tag));

/** A distinct, valid-looking PDF per `tag` (so different documents hash differently), optionally padded to `size` bytes. */
export function pdfOf(tag: string, size = 0): Buffer {
  const head = Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
  return size > head.length ? Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]) : head;
}
