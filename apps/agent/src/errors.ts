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

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "CloudApiError";
    this.code = code;
    this.status = status;
  }
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
