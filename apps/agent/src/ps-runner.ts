/**
 * Runs the embedded PowerShell scripts (powershell-scripts.ts) via
 * `spawn("powershell.exe", [...argv])` - never a shell string, never
 * `-Command` with interpolated values. See powershell-scripts.ts for why
 * `-File` + real parameters is used instead of building a `-Command` string.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";
import { SpoolerError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  args?: string[];
  /** Piped to the process's stdin (used only by the DPAPI helpers to avoid ever passing a secret as an argv value). */
  stdin?: string;
  timeoutMs?: number;
}

// name -> absolute path of the temp .ps1 file we've written it to, so we only
// write each script to disk once per process lifetime.
const scriptFileCache = new Map<string, string>();

function scriptsDir(localStoragePath: string): string {
  const dir = path.join(localStoragePath, "tmp", "ps-scripts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes `content` to a cached temp .ps1 file (idempotent per process) and returns its path. */
export function ensureScriptFile(name: string, content: string, localStoragePath: string): string {
  const cached = scriptFileCache.get(name);
  if (cached && existsSync(cached)) return cached;

  const dir = scriptsDir(localStoragePath);
  const filePath = path.join(dir, `${name}.ps1`);
  // Always (re)write - cheap, and guarantees dev-mode edits to the embedded
  // string take effect without a stale cached file on disk.
  writeFileSync(filePath, content, "utf8");
  scriptFileCache.set(name, filePath);
  return filePath;
}

/**
 * Spawns powershell.exe with an argv array. `-File scriptPath` plus
 * `options.args` are genuine, separate argv entries - PowerShell binds them
 * to the script's own `param()` block, they are never re-parsed as script
 * text (see powershell-scripts.ts).
 */
export function runPowerShellFile(scriptPath: string, options: RunOptions = {}, logger?: Logger): Promise<RunResult> {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...(options.args ?? []),
  ];
  return runPowerShellProcess(args, options, logger);
}

function runPowerShellProcess(args: string[], options: RunOptions, logger?: Logger): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(new SpoolerError("failed to spawn powershell.exe", { cause: String(err) }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      logger?.warn("powershell process error", { error: String(err) });
      reject(new SpoolerError("powershell process error", { cause: String(err) }));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (timedOut) {
        reject(new SpoolerError(`powershell command timed out after ${timeoutMs}ms`, { stdout, stderr }));
        return;
      }
      resolve({ code, stdout, stderr, durationMs });
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin, "utf8");
    }
    child.stdin?.end();
  });
}

/** Parses a single line (or block) of JSON emitted by one of our scripts. Throws SpoolerError on malformed output, rather than letting a JSON.parse exception surface raw. */
export function parseScriptJson<T>(result: RunResult, context: string): T {
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    throw new SpoolerError(`${context}: powershell produced no output`, {
      code: result.code,
      stderr: result.stderr.slice(0, 2000),
    });
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new SpoolerError(`${context}: could not parse powershell output as JSON`, {
      code: result.code,
      stdout: trimmed.slice(0, 2000),
      stderr: result.stderr.slice(0, 2000),
      cause: String(err),
    });
  }
}
