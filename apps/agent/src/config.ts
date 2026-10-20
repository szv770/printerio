/**
 * Environment-variable configuration. See `.env.example` for the documented
 * list. Loading is intentionally strict about types/ranges but lenient about
 * which fields are required for which command - `register` only needs
 * PRINTIO_API_URL, `start` also needs credentials (from env or secure
 * storage - see index.ts).
 */

import os from "node:os";
import path from "node:path";
import { ConfigError } from "./errors.js";
import type { LogLevel } from "./logger.js";

export type PrintFitMode = "fit" | "shrink" | "noscale";

export interface AgentConfig {
  apiUrl: string;
  agentId?: string;
  deviceSecret?: string;
  localStoragePath: string;
  logLevel: LogLevel;
  maxLocalStorageMb: number;
  pollIntervalSeconds: number;
  /** Ceiling (seconds) the outer poll loop's cycle-failure backoff may grow to - see orchestrator.ts computeNextPollDelayMs(). Never shrinks the happy-path cadence; only bounds how far it escalates during a sustained cloud outage. */
  maxPollIntervalSeconds: number;
  sumatraPath: string;
  spoolerPollIntervalMs: number;
  spoolerTimeoutSeconds: number;
  printFitMode: PrintFitMode;
  collateMultiCopy: boolean;
  /** Escape hatch for the startup dependency check (dependency-check.ts). Off by default; see .env.example for why it exists and why leaving it on is a bad idea. */
  skipDependencyCheck: boolean;
  /** PRINTIO_RAW_ONLY: a missing SumatraPDF is only a startup warning (raw-port jobs do not need it). */
  rawOnly: boolean;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const PRINT_FIT_MODES: readonly PrintFitMode[] = ["fit", "shrink", "noscale"];

function defaultLocalStoragePath(): string {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData || "C:\\ProgramData";
    return path.join(programData, "Printio", "Agent");
  }
  // Non-Windows is dev/test only - this agent targets Windows in production
  // (see README "Testing status").
  return path.join(os.homedir(), ".printio-agent-data");
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseBool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new ConfigError(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

export interface LoadConfigOptions {
  /** Require PRINTIO_AGENT_ID/PRINTIO_AGENT_SECRET to already be present in env. Defaults to false - `start` loads credentials separately from secure storage and merges them in. */
  requireCredentialsInEnv?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): AgentConfig {
  const env = options.env ?? process.env;

  const apiUrl = env.PRINTIO_API_URL?.trim();
  if (!apiUrl) {
    // Deliberately a reserved-for-documentation domain, not any real
    // deployment's own URL: an "example" that is somebody's genuine value is
    // indistinguishable from that value, which is precisely the bug class
    // that produced setup-agent.ps1's forever-re-asking URL prompt (see
    // .env.example's PRINTIO_API_URL comment).
    throw new ConfigError("PRINTIO_API_URL is required (e.g. https://printio.example.org)");
  }
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ConfigError(`PRINTIO_API_URL must be http(s), got ${apiUrl}`);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`PRINTIO_API_URL is not a valid URL: ${apiUrl}`);
  }

  const agentId = env.PRINTIO_AGENT_ID?.trim() || undefined;
  const deviceSecret = env.PRINTIO_AGENT_SECRET?.trim() || undefined;
  if (options.requireCredentialsInEnv && (!agentId || !deviceSecret)) {
    throw new ConfigError("PRINTIO_AGENT_ID and PRINTIO_AGENT_SECRET are required");
  }

  const logLevelRaw = (env.PRINTIO_LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevelRaw)) {
    throw new ConfigError(`PRINTIO_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${logLevelRaw}`);
  }

  const printFitModeRaw = (env.PRINTIO_PRINT_FIT_MODE?.trim().toLowerCase() || "fit") as PrintFitMode;
  if (!PRINT_FIT_MODES.includes(printFitModeRaw)) {
    throw new ConfigError(
      `PRINTIO_PRINT_FIT_MODE must be one of ${PRINT_FIT_MODES.join(", ")}, got ${printFitModeRaw}`,
    );
  }

  const pollIntervalSeconds = parsePositiveInt(
    "PRINTIO_POLL_INTERVAL_SECONDS",
    env.PRINTIO_POLL_INTERVAL_SECONDS,
    15,
  );
  const maxPollIntervalSeconds = parsePositiveInt(
    "PRINTIO_MAX_POLL_INTERVAL_SECONDS",
    env.PRINTIO_MAX_POLL_INTERVAL_SECONDS,
    300,
  );
  if (maxPollIntervalSeconds < pollIntervalSeconds) {
    throw new ConfigError(
      `PRINTIO_MAX_POLL_INTERVAL_SECONDS (${maxPollIntervalSeconds}) must be >= PRINTIO_POLL_INTERVAL_SECONDS (${pollIntervalSeconds})`,
    );
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    agentId,
    deviceSecret,
    localStoragePath: env.PRINTIO_LOCAL_STORAGE_PATH?.trim() || defaultLocalStoragePath(),
    logLevel: logLevelRaw,
    maxLocalStorageMb: parsePositiveInt("PRINTIO_MAX_LOCAL_STORAGE_MB", env.PRINTIO_MAX_LOCAL_STORAGE_MB, 2048),
    pollIntervalSeconds,
    maxPollIntervalSeconds,
    sumatraPath: env.PRINTIO_SUMATRA_PATH?.trim() || "SumatraPDF.exe",
    spoolerPollIntervalMs: parsePositiveInt(
      "PRINTIO_SPOOLER_POLL_INTERVAL_MS",
      env.PRINTIO_SPOOLER_POLL_INTERVAL_MS,
      2000,
    ),
    spoolerTimeoutSeconds: parsePositiveInt(
      "PRINTIO_SPOOLER_TIMEOUT_SECONDS",
      env.PRINTIO_SPOOLER_TIMEOUT_SECONDS,
      600,
    ),
    printFitMode: printFitModeRaw,
    collateMultiCopy: parseBool("PRINTIO_COLLATE_MULTI_COPY", env.PRINTIO_COLLATE_MULTI_COPY, true),
    skipDependencyCheck: parseBool(
      "PRINTIO_SKIP_DEPENDENCY_CHECK",
      env.PRINTIO_SKIP_DEPENDENCY_CHECK,
      false,
    ),
    rawOnly: parseBool("PRINTIO_RAW_ONLY", env.PRINTIO_RAW_ONLY, false),
  };
}
