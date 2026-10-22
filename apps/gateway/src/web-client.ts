// Typed client for the web app's /api/gateway/* endpoints (contract: docs/superpowers/specs/2026-10-22-gateway-contract.md).
import type { JobState } from "@printio/shared";
import type { FlatObject } from "./ipp/codec.js";

export interface ResolvedDevice {
  deviceId: string;
  userId: string;
  organizationId: string;
  displayName: string;
}

export type ResolveResult =
  | { kind: "ok"; device: ResolvedDevice }
  | { kind: "unknown" }
  | { kind: "revoked" }
  | { kind: "inactive_member" };

export type EventType = "attributes_requested" | "job_received" | "job_rejected" | "info";

export interface FinalizeRequest {
  deviceId: string;
  storagePath: string;
  fileName: string;
  sizeBytes: number;
  ipp: {
    jobName?: string;
    userAgent?: string;
    ippVersion?: string;
    attributes: FlatObject;
  };
}

export interface JobInfo {
  jobId: string;
  /** The web app's text job number (print_jobs.job_number, e.g. "JOB-2026-000002"). Display only: IPP job ids are integers. */
  jobNumber?: string;
  status: JobState;
  message?: string;
}

/** Permanent refusals from finalize: retrying will not help, so the client is told to stop (not 0x0506). */
export type RefusalReason = "quota_exceeded" | "rate_limited" | "invalid_request" | "intake_not_found" | "revoked" | "inactive_member";

export type FinalizeResult =
  | { kind: "ok"; job: JobInfo & { jobNumber: string } }
  | { kind: "bad_pdf"; message: string }
  | { kind: "refused"; reason: RefusalReason; message?: string };

export type CancelResult = { kind: "ok"; status: JobState } | { kind: "not_found" } | { kind: "not_cancellable"; message?: string };

export interface WebApi {
  resolveDevice(tokenHash: string): Promise<ResolveResult>;
  /** Best effort: implementations must never throw. */
  postEvent(event: { deviceId: string; type: EventType; userAgent?: string; detail?: Record<string, unknown> }): Promise<void>;
  finalize(req: FinalizeRequest): Promise<FinalizeResult>;
  getJob(jobId: string, deviceId: string): Promise<JobInfo | null>;
  cancelJob(jobId: string, deviceId: string): Promise<CancelResult>;
}

/** The web app is unreachable, timed out, answered 5xx, or rejected our credentials. Maps to IPP 0x0506. */
export class WebUnavailableError extends Error {}

export interface WebClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  /** Finalize downloads, preflights and runs policy server-side, so it gets a longer timeout. */
  finalizeTimeoutMs?: number;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onWarn?: (msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_FINALIZE_TIMEOUT = 60_000;
const DEFAULT_CACHE_TTL = 60_000;

export function createWebClient(opts: WebClientOptions): WebApi {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL;
  const warn = opts.onWarn ?? (() => {});
  const base = opts.baseUrl.replace(/\/+$/, "");
  const cache = new Map<string, { device: ResolvedDevice; expires: number }>();

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.secret}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WebUnavailableError(`web API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 500) throw new WebUnavailableError(`web API answered ${res.status}`);
    if (res.status === 401) {
      warn("web API rejected the gateway secret (401): check GATEWAY_SHARED_SECRET on both sides");
      throw new WebUnavailableError("web API rejected the gateway credentials");
    }
    let json: Record<string, unknown> = {};
    if (res.status !== 204) {
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
      } catch {
        // non-JSON body; status code alone decides
      }
    }
    return { status: res.status, json };
  }

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  return {
    async resolveDevice(tokenHash) {
      const hit = cache.get(tokenHash);
      if (hit && hit.expires > now()) return { kind: "ok", device: hit.device };
      cache.delete(tokenHash);
      const { status, json } = await call("POST", "/api/gateway/device/resolve", { tokenHash });
      if (status === 200) {
        const deviceId = str(json.deviceId);
        const userId = str(json.userId);
        const organizationId = str(json.organizationId);
        if (!deviceId || !userId || !organizationId) throw new WebUnavailableError("device/resolve returned an unexpected body");
        const device: ResolvedDevice = { deviceId, userId, organizationId, displayName: str(json.displayName) ?? "" };
        cache.set(tokenHash, { device, expires: now() + ttl });
        return { kind: "ok", device };
      }
      if (status === 403) return json.error === "inactive_member" ? { kind: "inactive_member" } : { kind: "revoked" };
      if (status === 404) return { kind: "unknown" };
      throw new WebUnavailableError(`device/resolve answered ${status}`);
    },

    async postEvent(event) {
      try {
        const { status } = await call("POST", "/api/gateway/events", event);
        if (status >= 400) warn("events endpoint refused an event", { status, type: event.type });
      } catch (err) {
        warn("could not post gateway event", { type: event.type, error: String(err) });
      }
    },

    async finalize(req) {
      const { status, json } = await call("POST", "/api/gateway/jobs/finalize", req, opts.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT);
      if (status === 200) {
        const jobId = str(json.jobId);
        // The web app sends its text job number; a plain number is accepted too (older contract wording).
        const rawNumber = json.jobNumber;
        const jobNumber = typeof rawNumber === "string" && rawNumber ? rawNumber : typeof rawNumber === "number" ? String(rawNumber) : undefined;
        const state = str(json.status);
        if (!jobId || !jobNumber || !state) throw new WebUnavailableError("finalize returned an unexpected body");
        return { kind: "ok", job: { jobId, jobNumber, status: state as JobState, message: str(json.message) } };
      }
      if (status === 422) return { kind: "bad_pdf", message: str(json.message) ?? "The file could not be read as a PDF." };
      const code = str(json.error);
      if (status === 403 && (code === "quota_exceeded" || code === "revoked" || code === "inactive_member")) {
        return { kind: "refused", reason: code, message: str(json.message) };
      }
      if (status === 429) return { kind: "refused", reason: "rate_limited", message: str(json.message) };
      if (status === 400) return { kind: "refused", reason: "invalid_request", message: str(json.message) };
      if (status === 404) return { kind: "refused", reason: "intake_not_found", message: str(json.message) };
      throw new WebUnavailableError(`finalize answered ${status}`);
    },

    async getJob(jobId, deviceId) {
      const { status, json } = await call("GET", `/api/gateway/jobs/${encodeURIComponent(jobId)}?deviceId=${encodeURIComponent(deviceId)}`);
      if (status === 404) return null;
      const state = str(json.status);
      if (status !== 200 || !state) throw new WebUnavailableError(`job lookup answered ${status}`);
      return { jobId: str(json.jobId) ?? jobId, status: state as JobState, message: str(json.message) };
    },

    async cancelJob(jobId, deviceId) {
      const { status, json } = await call("POST", `/api/gateway/jobs/${encodeURIComponent(jobId)}/cancel`, { deviceId });
      if (status === 200) return { kind: "ok", status: (str(json.status) ?? "cancelled") as JobState };
      if (status === 404) return { kind: "not_found" };
      if (status === 409 || status === 422 || status === 400) return { kind: "not_cancellable", message: str(json.message) };
      throw new WebUnavailableError(`cancel answered ${status}`);
    },
  };
}
