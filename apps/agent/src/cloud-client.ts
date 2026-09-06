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

import type { JobState } from "@printos/shared";
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

export interface HeartbeatResponse {
  ok: true;
  serverTime: string;
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
    /** Per-job override of this Agent's own PRINTOS_PRINT_FIT_MODE default - set by the cloud only for a booklet job (always "noscale"), absent otherwise. See config.ts's PrintFitMode and orchestrator.ts's fallback. */
    fitMode?: "fit" | "shrink" | "noscale";
  };
}

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

  /** POST /api/agents/heartbeat */
  async heartbeat(version: string, queues: HeartbeatQueue[]): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>(
      "POST",
      "/api/agents/heartbeat",
      { version, queues },
      { auth: true, retry: true },
    );
  }

  /** GET /api/agents/jobs/claimable */
  async getClaimableJobs(): Promise<ClaimableJob[]> {
    const res = await this.request<{ jobs: ClaimableJob[] }>("GET", "/api/agents/jobs/claimable", undefined, {
      auth: true,
      retry: true,
    });
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
  async getDownloadUrl(jobId: string): Promise<DownloadUrlResponse> {
    return this.request<DownloadUrlResponse>(
      "GET",
      `/api/agents/jobs/${encodeURIComponent(jobId)}/download-url`,
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

  /** GET /api/agents/commands */
  async getCommands(): Promise<RemoteCommandEnvelope[]> {
    const res = await this.request<{ commands: RemoteCommandEnvelope[] }>("GET", "/api/agents/commands", undefined, {
      auth: true,
      retry: true,
    });
    return res.commands;
  }

  /** POST /api/agents/commands/:commandId/ack */
  async ackCommand(
    commandId: string,
    status: "completed" | "failed",
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
