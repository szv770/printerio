/**
 * Environment-variable configuration. See `.env.example` for the documented
 * list. Loading is intentionally strict about types/ranges but lenient about
 * which fields are required for which command - `register` only needs
 * PRINTOS_API_URL, `start` also needs credentials (from env or secure
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
  sumatraPath: string;
  spoolerPollIntervalMs: number;
  spoolerTimeoutSeconds: number;
  printFitMode: PrintFitMode;
  collateMultiCopy: boolean;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const PRINT_FIT_MODES: readonly PrintFitMode[] = ["fit", "shrink", "noscale"];

function defaultLocalStoragePath(): string {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData || "C:\\ProgramData";
    return path.join(programData, "PrintOS", "Agent");
  }
  // Non-Windows is dev/test only - this agent targets Windows in production
  // (see README "Testing status").
  return path.join(os.homedir(), ".printos-agent-data");
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
  /** Require PRINTOS_AGENT_ID/PRINTOS_AGENT_SECRET to already be present in env. Defaults to false - `start` loads credentials separately from secure storage and merges them in. */
  requireCredentialsInEnv?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): AgentConfig {
  const env = options.env ?? process.env;

  const apiUrl = env.PRINTOS_API_URL?.trim();
  if (!apiUrl) {
    throw new ConfigError("PRINTOS_API_URL is required (e.g. https://printos.example.org)");
  }
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ConfigError(`PRINTOS_API_URL must be http(s), got ${apiUrl}`);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`PRINTOS_API_URL is not a valid URL: ${apiUrl}`);
  }

  const agentId = env.PRINTOS_AGENT_ID?.trim() || undefined;
  const deviceSecret = env.PRINTOS_AGENT_SECRET?.trim() || undefined;
  if (options.requireCredentialsInEnv && (!agentId || !deviceSecret)) {
    throw new ConfigError("PRINTOS_AGENT_ID and PRINTOS_AGENT_SECRET are required");
  }

  const logLevelRaw = (env.PRINTOS_LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevelRaw)) {
    throw new ConfigError(`PRINTOS_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${logLevelRaw}`);
  }

  const printFitModeRaw = (env.PRINTOS_PRINT_FIT_MODE?.trim().toLowerCase() || "fit") as PrintFitMode;
  if (!PRINT_FIT_MODES.includes(printFitModeRaw)) {
    throw new ConfigError(
      `PRINTOS_PRINT_FIT_MODE must be one of ${PRINT_FIT_MODES.join(", ")}, got ${printFitModeRaw}`,
    );
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    agentId,
    deviceSecret,
    localStoragePath: env.PRINTOS_LOCAL_STORAGE_PATH?.trim() || defaultLocalStoragePath(),
    logLevel: logLevelRaw,
    maxLocalStorageMb: parsePositiveInt("PRINTOS_MAX_LOCAL_STORAGE_MB", env.PRINTOS_MAX_LOCAL_STORAGE_MB, 2048),
    pollIntervalSeconds: parsePositiveInt("PRINTOS_POLL_INTERVAL_SECONDS", env.PRINTOS_POLL_INTERVAL_SECONDS, 15),
    sumatraPath: env.PRINTOS_SUMATRA_PATH?.trim() || "SumatraPDF.exe",
    spoolerPollIntervalMs: parsePositiveInt(
      "PRINTOS_SPOOLER_POLL_INTERVAL_MS",
      env.PRINTOS_SPOOLER_POLL_INTERVAL_MS,
      2000,
    ),
    spoolerTimeoutSeconds: parsePositiveInt(
      "PRINTOS_SPOOLER_TIMEOUT_SECONDS",
      env.PRINTOS_SPOOLER_TIMEOUT_SECONDS,
      600,
    ),
    printFitMode: printFitModeRaw,
    collateMultiCopy: parseBool("PRINTOS_COLLATE_MULTI_COPY", env.PRINTOS_COLLATE_MULTI_COPY, true),
  };
}
