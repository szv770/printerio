/**
 * Typed HTTP client implementing docs/agent-api.md exactly. Uses native
 * `fetch` (Node 20+) - no axios/got dependency needed.
 *
 * - Every request except `register` carries `Authorization: Bearer
 *   <agentId>.<deviceSecret>` (docs/agent-api.md "Authentication").
 * - Network-level failures (DNS, TCP, TLS, timeout - fetch throwing before
 *   any HTTP response exists) are always caught and re-thrown as
 *   `CloudNetworkError`, never a raw `TypeError`/`DOMException` from fetch
 *   itself. HTTP-level errors use the documented `{ error: { code, message
 *   } }` body shape and become `CloudApiError` - except `claim`, whose 409
 *   response is a deliberately different, smaller shape
 *   (`{ ok: false, reason }`) per docs/agent-api.md, handled as data rather
 *   than an error.
 * - Retries with exponential backoff apply only to network errors and 5xx
 *   responses - never to 4xx (a 401/403/404/409 is a decision, not a
 *   transient fault, and retrying it would just repeat the same rejection).
 * - This client never lets a raw fetch-level exception escape uncaught -
 *   every network condition is normalized to one of our typed error
 *   classes before a caller ever sees it. Callers (orchestrator.ts,
 *   health-monitor.ts) still wrap every call in their own try/catch per
 *   docs/architecture.md sec 17; this client's job is to make sure what
 *   they catch is always one of ours.
 */

import type { JobState, RawTarget } from "@printio/shared";
import type { Logger } from "./logger.js";
import { redactBearerHeader } from "./logger.js";
import { CloudApiError, CloudNetworkError } from "./errors.js";

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface RegisterResponse {
  agentId: string;
  deviceSecret: string;
  organizationId: string;
}

export interface HeartbeatQueue {
  windowsQueueName: string;
  driverName: string;
  portName: string;
  status: string;
}

/** What this Agent reports about the machine it runs on - see machine-info.ts for what is and isn't included, and why. */
export interface HeartbeatMachineInfo {
  hostname: string;
  osVersion: string;
  ipAddresses: string[];
  isGitCheckout: boolean;
}

/** What the printer itself said when asked (apps/agent/src/printer-probe.ts); display only. */
export interface HeartbeatRawPrinter {
  printerId: string;
  reachable: boolean;
  answered: boolean;
  online?: boolean;
  code?: number;
  display?: string;
}

export interface HeartbeatResponse {
  ok: true;
  serverTime: string;
  /** The direct-port printers this agent should ask about with its next heartbeat. Absent from an older cloud. */
  rawPrinters?: Array<{ printerId: string; host: string; port: number }>;
  /**
   * True while an org_admin has this Agent paused (agents.paused). The Agent
   * honors it by not polling for claimable jobs at all
   * (orchestrator.ts/health-monitor.ts), which saves a pointless round trip
   * and makes the Agent's own log say plainly why it is idle - but this is
   * DEFENSE IN DEPTH ONLY. The pause that actually matters is enforced in the
   * cloud: `/api/agents/jobs/claimable` returns nothing and
   * `/api/agents/jobs/:jobId/claim` refuses with 409 `agent_paused` while it
   * is set, so an older or modified Agent that ignores this field still
   * cannot take work. Absent from an older server's response, in which case
   * it reads as `false` and nothing changes.
   */
  paused?: boolean;
}

export interface ClaimableJob {
  jobId: string;
  printerProfileId: string;
  jobNumber: string;
}

export interface ClaimResponseOk {
  ok: true;
  leaseExpiresAt: string;
}
export interface ClaimResponseConflict {
  ok: false;
  reason: string;
}
export type ClaimResponse = ClaimResponseOk | ClaimResponseConflict;

export interface DownloadUrlResponse {
  downloadUrl: string;
  expiresInSeconds: number;
  fileName: string;
  /**
   * Which state the web app left the job in: "claimed" when this Agent asked for `keepClaimed` and the server
   * honoured it (the job can still be released back to the queue), "downloading" for an older server that moved
   * it already. Absent = older server = treat as "downloading".
   */
  jobStatus?: "claimed" | "downloading";
  printRequest: {
    jobId: string;
    printerProfileId: string;
    windowsQueueName: string;
    pageCount: number;
    copies: number;
    colorMode: "bw" | "color";
    duplex: boolean;
    paperSize: string;
    finishing: { staple: boolean; booklet: boolean; punch: boolean };
    /** Per-job override of this Agent's own PRINTIO_PRINT_FIT_MODE default - set by the cloud only for a booklet job (always "noscale"), absent otherwise. See config.ts's PrintFitMode and orchestrator.ts's fallback. */
    fitMode?: "fit" | "shrink" | "noscale";
    /** Present only for output_mode='raw' profiles: send straight to host:port, no Windows queue (windowsQueueName is ""). */
    raw?: RawTarget;
  };
}

export type ReleaseResponse =
  | { ok: true; outcome: "waiting"; tries: number; retryAt: string }
  | { ok: true; outcome: "failed" };

export interface RemoteCommandEnvelope {
  id: string;
  command: string;
  payload: Record<string, unknown>;
}

export interface CloudClientOptions {
  apiUrl: string;
  agentId?: string;
  deviceSecret?: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

interface RawResponse {
  status: number;
  json: unknown;
}

export class CloudClient {
  private apiUrl: string;
  private agentId?: string;
  private deviceSecret?: string;
  private logger: Logger;
  private fetchImpl: typeof fetch;

  constructor(options: CloudClientOptions) {
    this.apiUrl = options.apiUrl;
    this.agentId = options.agentId;
    this.deviceSecret = options.deviceSecret;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Consecutive 401/403 answers to the polls (heartbeat, commands, claimable); 0 after any other answer. The orchestrator backs off when this stays high. */
  consecutiveAuthFailures = 0;

  /**
   * One of the three idempotent polls. NOT retried inside the request: the next cycle (60 s or more away) is the
   * retry, and an in-request retry loop against a struggling server multiplies the invocations it is already failing
   * to serve. Also tracks consecutive 401/403 so a revoked agent can slow itself down.
   */
  private async poll<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    try {
      const res = await this.request<T>(method, urlPath, body, { auth: true, retry: false });
      this.consecutiveAuthFailures = 0;
      return res;
    } catch (err) {
      if (err instanceof CloudApiError && (err.status === 401 || err.status === 403)) this.consecutiveAuthFailures += 1;
      else if (err instanceof CloudApiError) this.consecutiveAuthFailures = 0;
      throw err;
    }
  }

  /** Called after a successful `register()` so subsequent calls are authenticated. */
  setCredentials(agentId: string, deviceSecret: string): void {
    this.agentId = agentId;
    this.deviceSecret = deviceSecret;
  }

  private authHeader(): string | undefined {
    if (!this.agentId || !this.deviceSecret) return undefined;
    return `Bearer ${this.agentId}.${this.deviceSecret}`;
  }

  /**
   * Sends one request with retry/backoff on network errors and 5xx
   * responses, returning the raw status + parsed body for ANY status code
   * (including 4xx) - callers decide what each status means for their
   * endpoint. Never throws for an HTTP error response; only throws
   * `CloudNetworkError` if every retry attempt fails at the network level,
   * or `CloudApiError` (NOT_REGISTERED) if auth was required but no
   * credentials are configured yet.
   */
  private async sendWithRetry(
    method: string,
    urlPath: string,
    body: unknown | undefined,
    opts: { auth: boolean; retry: boolean; timeoutMs?: number },
  ): Promise<RawResponse> {
    const url = `${this.apiUrl}${urlPath}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth) {
      const auth = this.authHeader();
      if (!auth) {
        throw new CloudApiError("no credentials configured - run `register` first", "NOT_REGISTERED", 401);
      }
      headers.Authorization = auth;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status >= 500 && opts.retry && attempt <= MAX_RETRIES) {
          this.logger.warn("cloud API returned 5xx - retrying", {
            urlPath,
            status: res.status,
            attempt,
            authorization: redactBearerHeader(headers.Authorization),
          });
          await this.backoff(attempt);
          continue;
        }

        let json: unknown = {};
        try {
          json = res.status === 204 ? {} : await res.json();
        } catch {
          // Non-JSON body (e.g. a proxy error page) - leave json as {}, callers handle missing fields.
        }
        return { status: res.status, json };
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err instanceof Error && err.name === "AbortError";
        const message = isAbort
          ? `request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);

        if (opts.retry && attempt <= MAX_RETRIES) {
          this.logger.warn("network error calling cloud API - retrying", { urlPath, attempt, error: message });
          await this.backoff(attempt);
          continue;
        }
        throw new CloudNetworkError(`network error calling ${urlPath}: ${message}`, err);
      }
    }
  }

  private backoff(attempt: number): Promise<void> {
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 250);
    return new Promise((resolve) => setTimeout(resolve, delay + jitter));
  }

  /** Standard path: 2xx returns `json as T`, anything else throws CloudApiError using the documented `{error:{code,message}}` envelope. */
  private async request<T>(
    method: string,
    urlPath: string,
    body: unknown | undefined,
    opts: { auth: boolean; retry: boolean; timeoutMs?: number },
  ): Promise<T> {
    const { status, json } = await this.sendWithRetry(method, urlPath, body, opts);
    if (status >= 200 && status < 300) return json as T;
    const errBody = (json ?? {}) as ApiErrorBody;
    throw new CloudApiError(
      errBody.error?.message ?? `request failed with status ${status}`,
      errBody.error?.code ?? `HTTP_${status}`,
      status,
    );
  }

  /** POST /api/agents/register - the one call made with no Authorization header. */
  async register(enrollmentCode: string): Promise<RegisterResponse> {
    return this.request<RegisterResponse>(
      "POST",
      "/api/agents/register",
      { enrollmentCode },
      { auth: false, retry: true },
    );
  }

  /**
   * POST /api/agents/heartbeat. `machine` is optional on the wire (the server
   * treats a heartbeat without it exactly as before - see
   * docs/agent-api.md), so this parameter stays optional here too rather
   * than forcing every existing caller/test to supply one.
   */
  async heartbeat(
    version: string,
    queues: HeartbeatQueue[],
    machine?: HeartbeatMachineInfo,
    rawPrinters?: HeartbeatRawPrinter[],
  ): Promise<HeartbeatResponse> {
    return this.poll<HeartbeatResponse>("POST", "/api/agents/heartbeat", {
      version,
      queues,
      ...(machine ? { machine } : {}),
      ...(rawPrinters && rawPrinters.length > 0 ? { rawPrinters } : {}),
    });
  }

  /** GET /api/agents/jobs/claimable */
  async getClaimableJobs(): Promise<ClaimableJob[]> {
    const res = await this.poll<{ jobs: ClaimableJob[] }>("GET", "/api/agents/jobs/claimable");
    return res.jobs;
  }

  /**
   * POST /api/agents/jobs/:jobId/claim - 409 is a normal, expected outcome
   * (another agent/attempt won the atomic claim race - docs/architecture.md
   * sec 13), carrying its own `{ ok:false, reason }` body shape rather than
   * the generic error envelope, and is never retried.
   */
  async claimJob(jobId: string): Promise<ClaimResponse> {
    const { status, json } = await this.sendWithRetry(
      "POST",
      `/api/agents/jobs/${encodeURIComponent(jobId)}/claim`,
      {},
      { auth: true, retry: true },
    );
    if (status === 200) {
      const body = json as Partial<ClaimResponseOk>;
      return { ok: true, leaseExpiresAt: body.leaseExpiresAt ?? new Date().toISOString() };
    }
    if (status === 409) {
      const body = json as Partial<ClaimResponseConflict>;
      return { ok: false, reason: body.reason ?? "conflict" };
    }
    const errBody = (json ?? {}) as ApiErrorBody;
    throw new CloudApiError(
      errBody.error?.message ?? `claim failed with status ${status}`,
      errBody.error?.code ?? `HTTP_${status}`,
      status,
    );
  }

  /** GET /api/agents/jobs/:jobId/download-url */
  async getDownloadUrl(jobId: string, opts: { keepClaimed?: boolean } = {}): Promise<DownloadUrlResponse> {
    return this.request<DownloadUrlResponse>(
      "GET",
      `/api/agents/jobs/${encodeURIComponent(jobId)}/download-url${opts.keepClaimed ? "?keepClaimed=1" : ""}`,
      undefined,
      { auth: true, retry: true },
    );
  }

  /** POST /api/agents/jobs/:jobId/status */
  async reportStatus(
    jobId: string,
    status: JobState,
    message?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.request<{ ok: true }>(
      "POST",
      `/api/agents/jobs/${encodeURIComponent(jobId)}/status`,
      { status, message, metadata },
      { auth: true, retry: true },
    );
  }

  /**
   * POST /api/agents/jobs/:jobId/release - hand a claimed job back to the queue because the printer could not take
   * it right now (docs/agent-api.md). The web app decides: `waiting` (retry later, with the time) or `failed`
   * (the job has been unprintable for the whole waiting window). Throws CloudApiError: 409 = the job is no longer
   * claimed by us, 404 = an older web app without this endpoint.
   */
  async releaseJob(jobId: string, kind: "unavailable" | "unknown", detail?: string): Promise<ReleaseResponse> {
    return this.request<ReleaseResponse>(
      "POST",
      `/api/agents/jobs/${encodeURIComponent(jobId)}/release`,
      { kind, ...(detail ? { detail: detail.slice(0, 300) } : {}) },
      { auth: true, retry: true },
    );
  }

  /** GET /api/agents/commands */
  async getCommands(): Promise<RemoteCommandEnvelope[]> {
    const res = await this.poll<{ commands: RemoteCommandEnvelope[] }>("GET", "/api/agents/commands");
    return res.commands;
  }

  /** POST /api/agents/commands/:commandId/ack */
  async ackCommand(
    commandId: string,
    status: "completed" | "failed" | "progress",
    result?: Record<string, unknown>,
  ): Promise<void> {
    await this.request<{ ok: true }>(
      "POST",
      `/api/agents/commands/${encodeURIComponent(commandId)}/ack`,
      { status, result },
      { auth: true, retry: true },
    );
  }
}
