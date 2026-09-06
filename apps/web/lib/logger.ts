import "server-only";

/**
 * Small structured logger for the cloud app. Deliberately dependency-free
 * (no winston/pino) - on Vercel, stdout/stderr already becomes searchable
 * logs, so there's no need for a file-writing story like apps/agent's
 * logger has; the point of this module is the same as that one's, though:
 * a single place `redact()` lives so nothing accidentally logs a secret.
 *
 * Hard requirement (docs/architecture.md - "never log secrets"): device
 * secrets, service-role keys, signed URLs, bearer headers, and full
 * document contents must never appear in a log line. Route anything
 * secret-shaped through redact()/redactBearerHeader() rather than inlining
 * ad-hoc masking at the call site.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEY_PATTERN = /secret|password|token|authorization|devicesecret|apikey|signedurl/i;

/**
 * Recursively redacts anything that looks like a secret by key name, and
 * truncates long string values (a cheap guard against accidentally logging
 * full file contents/base64 blobs). Never throws - a redaction bug must not
 * itself become a crash.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated: too deep]";
  try {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 500)}...[${value.length} chars]` : value;
    }
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "***redacted***" : redact(val, depth + 1);
    }
    return out;
  } catch {
    return "[redaction failed]";
  }
}

/** Masks a `Bearer <agentId>.<deviceSecret>` header down to the agentId only. */
export function redactBearerHeader(header: string | null | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+([^.]+)\.(.+)$/.exec(header);
  if (!match) return "Bearer ***redacted***";
  return `Bearer ${match[1]}.***redacted***`;
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
