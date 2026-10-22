/**
 * Small structured logger. Deliberately dependency-free (no winston/pino) -
 * this agent's logging needs are modest: leveled console output plus a
 * simple append-only log file under the local storage path.
 *
 * Hard requirement (docs/architecture.md - "never log secrets"): the device
 * secret, the raw `Authorization` header, signed download URLs (they are
 * bearer-equivalent - anyone with the URL can download the file until it
 * expires), and full document contents/paths-with-content must never appear
 * in a log line. `redact()` below is the one place that responsibility lives;
 * call sites should route anything secret-shaped through it rather than
 * inlining ad-hoc masking.
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that merges `fields` into every call (e.g. { jobId }). */
  child(fields: Record<string, unknown>): Logger;
}

const SECRET_KEY_PATTERN = /secret|password|token|authorization|devicesecret|apikey/i;

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
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "***redacted***";
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  } catch {
    return "[redaction failed]";
  }
}

/** Masks a `Bearer <agentId>.<deviceSecret>` header down to the agentId only. */
export function redactBearerHeader(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+([^.]+)\.(.+)$/.exec(header);
  if (!match) return "Bearer ***redacted***";
  return `Bearer ${match[1]}.***redacted***`;
}

/** One day's log file stops growing at this size (console output is unaffected). */
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

/** Bytes written so far per log file, seeded from disk once, so child loggers share one count. */
const logFileBytes = new Map<string, number>();

export interface LoggerOptions {
  level: LogLevel;
  /** Per-file size cap in bytes (default MAX_LOG_FILE_BYTES). */
  maxFileBytes?: number;
  /** Directory to write `agent.log` into. If omitted, file logging is skipped (console only). */
  logDir?: string;
}

function formatLine(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined): string {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  return JSON.stringify(entry);
}

export function createLogger(options: LoggerOptions, baseFields: Record<string, unknown> = {}): Logger {
  let logFilePath: string | undefined;
  if (options.logDir) {
    try {
      mkdirSync(options.logDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      logFilePath = path.join(options.logDir, `agent-${stamp}.log`);
    } catch {
      // Best-effort only - console logging still works if the log dir can't be created.
      logFilePath = undefined;
    }
  }

  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) return;
    const merged = { ...baseFields, ...fields };
    const line = formatLine(level, msg, Object.keys(merged).length ? merged : undefined);

    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(line);

    if (logFilePath) {
      try {
        let used = logFileBytes.get(logFilePath);
        if (used === undefined) {
          try {
            used = statSync(logFilePath).size;
          } catch {
            used = 0;
          }
        }
        if (used >= (options.maxFileBytes ?? MAX_LOG_FILE_BYTES)) return;
        logFileBytes.set(logFilePath, used + Buffer.byteLength(line) + 1);
        appendFileSync(logFilePath, line + "\n", "utf8");
      } catch {
        // Never let a logging failure (e.g. disk full) crash the process.
      }
    }
  }

  const logger: Logger = {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger(options, { ...baseFields, ...fields }),
  };
  return logger;
}
