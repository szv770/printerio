// Tiny JSON-lines logger. Never logs secrets: device tokens in hostnames and the shared secret are masked.
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const TOKEN_IN_HOST = /u-[a-z2-7]{39}/gi;

/** Masks device tokens (u-<39 chars>) anywhere in a string. */
export function maskTokens(s: string): string {
  return s.replace(TOKEN_IN_HOST, "u-<token>");
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    try {
      sink(maskTokens(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields })));
    } catch {
      // logging must never throw
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
