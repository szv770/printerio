/**
 * Error types used across the agent. Keeping these as distinct classes (rather
 * than throwing raw strings/Errors everywhere) lets callers - especially
 * orchestrator.ts, whose entire job is "never let a per-job failure crash the
 * process" (docs/architecture.md sec 17) - catch and classify failures
 * without string-matching messages.
 */

/** The cloud API returned a structured `{ error: { code, message } }` response. */
export class CloudApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** From a 429's Retry-After header (seconds); undefined otherwise. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "CloudApiError";
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** True for the website's "you are asking too often, slow down" answer (HTTP 429): not a fault, just a request to back off. */
export function isRateLimited(err: unknown): err is CloudApiError {
  return err instanceof CloudApiError && err.status === 429;
}

/** fetch() itself failed (DNS, TCP, TLS, timeout) - no HTTP response at all. */
export class CloudNetworkError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CloudNetworkError";
    this.cause = cause;
  }
}

/** Invalid/missing configuration at startup - this one IS allowed to abort the process. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** SumatraPDF invocation failed or exited non-zero. */
export class PrintExecutionError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PrintExecutionError";
    this.details = details;
  }
}

/** A PowerShell/spooler operation failed (Get-Printer, Get-PrintJob, Remove-PrintJob, ...). */
export class SpoolerError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SpoolerError";
    this.details = details;
  }
}

/** A downloaded file failed validation (not a PDF, size mismatch, zero bytes, ...). */
export class DownloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadValidationError";
  }
}

/**
 * Fetching the job's document failed for a reason that says nothing about the job itself (network down, the
 * storage service answered 5xx/429). The job is released back to the queue to wait, not failed.
 * A missing, empty or non-PDF document stays a DownloadValidationError (permanent).
 */
export class TransientDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientDownloadError";
  }
}
