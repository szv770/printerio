/**
 * The CHECK_FOR_UPDATE remote command's implementation (docs/architecture.md
 * sec 12): the exact same self-update sequence
 * apps/agent/scripts/setup-agent.ps1 already performs at step 0/6, run on
 * demand from the admin console instead of only when someone is physically
 * at the machine double-clicking setup-agent.bat.
 *
 * The safety properties that make this an acceptable addition to a FIXED
 * allow-list rather than a remote-execution backdoor:
 *
 * - **Nothing is interpolated.** The two commands are hardcoded argv arrays -
 *   `git pull --ff-only` and `<pnpm> install --frozen-lockfile --ignore-scripts` - spawned with `shell: false`,
 *   in one fixed working directory the Agent computes from its own module
 *   path. The CHECK_FOR_UPDATE payload is empty by contract
 *   (`RemoteCommandPayload` in @printio/shared) and this module never reads
 *   it: there is no branch name, remote, path, flag, or command string that
 *   can travel from the cloud into a process invocation here.
 * - **Install is reproducible and runs no dependency scripts.** `--frozen-lockfile`
 *   installs exactly what pnpm-lock.yaml pins (and fails instead of resolving
 *   newer versions); `--ignore-scripts` stops any dependency's install /
 *   postinstall script from running as the service account (LocalSystem).
 *   Nothing the Agent or gateway needs is built by a dependency script.
 * - **`--ff-only`, not a bare `pull`.** setup-agent.ps1's plain `git pull`
 *   can, in principle, produce a merge commit on a machine with local
 *   commits. Unattended and unwatched, the honest outcome there is to refuse
 *   and say so, so this uses the fast-forward-only form: it either advances
 *   cleanly to what the remote has, or it fails and changes nothing.
 * - **It refuses to pretend.** If the Agent is not running from a real git
 *   checkout (the common case of a Downloads-ZIP extraction), it does not
 *   silently do nothing - it acks back a specific, actionable
 *   "not_a_git_checkout" result the admin console renders as an instruction
 *   to re-run setup-agent.ps1 by hand.
 * - **The restart is the Agent's own existing mechanism.** After a
 *   successful update the handler reuses `scheduleServiceRestart` - the same
 *   controlled exit RESTART_AGENT_SERVICE already uses, which always acks
 *   first and lets the Windows Service Control Manager's configured recovery
 *   action relaunch the process. No new restart path is introduced here.
 * - **The gateway restart is one more fixed command, run before that.** The
 *   IPP gateway is a second Windows service run from the SAME checkout, so
 *   after a successful update it would keep running old code. On win32 only,
 *   and only after pull AND install both succeeded, this runs exactly
 *   `powershell.exe -NoProfile -NonInteractive -Command "Restart-Service
 *   -DisplayName 'Printio IPP Gateway' -ErrorAction Stop"` (the service's display
 *   name): a hardcoded argv, `shell: false`, a timeout, no
 *   interpolation, nothing from the payload. A missing or failing gateway
 *   service never fails the update; it becomes a plain note in the message.
 *   The Agent's own restart is scheduled by the caller only after this
 *   function returns, so it always happens last (it is the process that
 *   reports the result).
 * - **pnpm is found on the local disk, never from the cloud.** The Agent runs
 *   as a Windows service (LocalSystem): no user npm folder on PATH, and Node
 *   >= 20 cannot spawn a `.cmd` shim with shell:false. `resolvePnpmLauncher`
 *   looks for `pnpm.cjs` (run as `<node.exe> <pnpm.cjs> install`, no shell)
 *   via PRINTIO_PNPM_PATH, then the global npm prefixes (Program Files\nodejs,
 *   %APPDATA%\npm, every C:\Users\*\AppData\Roaming\npm), then a validated
 *   pnpm.cmd shim via `cmd.exe /d /s /c`, then corepack. It runs BEFORE the
 *   pull, so a missing pnpm never leaves half-updated code behind.
 * - **`git rev-parse --short HEAD`** (fixed argv) is run before and after the
 *   pull purely to tell the admin which version it moved from and to.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";

const GIT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;
const GATEWAY_RESTART_TIMEOUT_MS = 60_000;

/** Display name of the gateway service (apps/gateway/src/windows-service.ts); proven on the real server with `Start-Service -DisplayName`. */
const GATEWAY_SERVICE_DISPLAY_NAME = "Printio IPP Gateway";
const GATEWAY_RESTART_ARGS: readonly string[] = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `Restart-Service -DisplayName "${GATEWAY_SERVICE_DISPLAY_NAME}" -ErrorAction Stop`,
];

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type SelfUpdateReason =
  | "updated"
  | "already_up_to_date"
  | "not_a_git_checkout"
  | "git_unavailable"
  | "git_failed"
  | "install_failed"
  | "pnpm_not_found";

export interface SelfUpdateResult {
  /** True only when the checkout actually advanced AND dependencies were re-installed successfully - i.e. a restart is warranted. */
  updated: boolean;
  reason: SelfUpdateReason;
  /** Plain-English, admin-facing - this string is what the console shows verbatim. */
  message: string;
  repoRoot: string;
  /** Only set when `updated`: whether the gateway service was restarted (false = a note explains why is in `message`). */
  gatewayRestarted?: boolean;
  /** Short commit before / after, when known (set when `updated`). */
  from?: string;
  to?: string;
  /** Which visible step a failure happened in, so the admin page can mark it. */
  failedStep?: UpdateStep;
}

/** The steps the admin page shows live (the page adds "restarting" and "done" itself). */
export type UpdateStep = "checking" | "downloading" | "installing";

export interface UpdateProgress {
  step: UpdateStep;
  /** Plain English for the admin page. */
  message: string;
}

/** What a check-only run (CHECK_FOR_UPDATE with mode "check_only") answers. */
export interface UpdateCheckResult {
  mode: "check_only";
  updateAvailable: boolean;
  reason: "update_available" | "up_to_date" | "not_a_git_checkout" | "git_unavailable" | "git_failed";
  message: string;
  current?: string;
  latest?: string;
  latestMessage?: string;
  behind?: number;
}

/** Extra spawn options; the only ones the updater ever sets. */
export interface RunOptions {
  /** Complete environment for the child (already merged with process.env). */
  env?: Record<string, string>;
  /** Pass the single cmd.exe /c argument through untouched (needed for the quoted .cmd form). */
  windowsVerbatimArguments?: boolean;
}

/** The small slice of the filesystem pnpm discovery needs - injected for tests. */
export interface SelfUpdateFs {
  exists: (p: string) => boolean;
  listDir: (p: string) => string[];
}

export interface SelfUpdateDeps {
  repoRoot: string;
  logger: Logger;
  /** Injected so tests can drive every branch without a real git remote; production passes `runCommand`. */
  run: (command: string, args: readonly string[], cwd: string, timeoutMs: number, options?: RunOptions) => Promise<CommandOutcome>;
  /** Filesystem used to find pnpm; defaults to the real one. */
  fs?: SelfUpdateFs;
  /** Environment used to find pnpm (PRINTIO_PNPM_PATH, ProgramFiles, APPDATA, PATH); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The node binary that runs pnpm.cjs; defaults to process.execPath. */
  execPath?: string;
  /** Injected for the same reason; production passes `isGitCheckout`. */
  hasGitCheckout: (repoRoot: string) => boolean;
  /** Injected so tests can exercise the non-Windows path; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Told which visible step the update is in (the orchestrator forwards it to the cloud). Failures here are swallowed. */
  onProgress?: (progress: UpdateProgress) => void | Promise<void>;
}

const PROGRESS_REPORT_TIMEOUT_MS = 5_000;

/** Reports a step without ever letting the report break, or noticeably slow, the update itself. */
async function reportProgress(deps: SelfUpdateDeps, progress: UpdateProgress): Promise<void> {
  if (!deps.onProgress) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => deps.onProgress!(progress)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROGRESS_REPORT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    deps.logger.warn("could not report update progress", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The repository root this Agent is running from: two levels above the
 * `apps/agent` package (which is one level above this module in both `src/`
 * under tsx and `dist/` when built, exactly like version.ts's package.json
 * lookup).
 */
export function resolveRepoRoot(moduleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  // here = <repo>/apps/agent/{src,dist}
  return path.resolve(here, "..", "..", "..");
}

/** A real git clone has a `.git` entry at its root (a directory normally, a file for a worktree/submodule - both count). */
export function isGitCheckout(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, ".git"));
}

/** pnpm is a shell shim on Windows, which `spawn` with `shell:false` cannot execute under its bare name. */
export function pnpmExecutable(platform: string = process.platform): string {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export const realFs: SelfUpdateFs = {
  exists: (p) => existsSync(p),
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

export interface PnpmLauncher {
  command: string;
  /** Full argv including "install". */
  args: string[];
  kind: "node-cjs" | "exe" | "cmd-shim" | "corepack";
  /** Environment for the child (PATH with node's directory first). */
  env?: Record<string, string>;
  windowsVerbatimArguments?: boolean;
}

export interface PnpmResolution {
  launcher: PnpmLauncher | null;
  /** Plain reasons something configured was refused (e.g. an unusable PRINTIO_PNPM_PATH). */
  rejected: string[];
}

/** Characters that must never appear in a path that ends up inside the cmd.exe command line. */
const CMD_UNSAFE = /["&|^%<>\r\n\0]/;

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Case-insensitive env key lookup (Windows spells it "Path"; a spread copy of process.env loses the case-insensitivity). */
function envKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const k = envKey(env, name);
  const v = k ? env[k] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}

/** The only install invocation (security review F5): exact lockfile, no dependency lifecycle scripts. */
export const PNPM_INSTALL_ARGS = ["install", "--frozen-lockfile", "--ignore-scripts"] as const;

/**
 * Finds a way to run `pnpm install` that works from a Windows service and on
 * Linux/mac, without a shell wherever possible. Everything comes from the
 * local filesystem and environment; no cloud value is involved. Pure apart
 * from the injected `fs`.
 */
export function resolvePnpmLauncher(opts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  fs: SelfUpdateFs;
}): PnpmResolution {
  const { platform, env, execPath, fs } = opts;
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const rejected: string[] = [];
  const nodeDir = P.dirname(execPath);

  const childEnv = (): Record<string, string> => {
    const e = cleanEnv(env);
    const key = envKey(env, "PATH") ?? (win ? "Path" : "PATH");
    const sep = win ? ";" : ":";
    const existing = e[key];
    e[key] = existing ? `${nodeDir}${sep}${existing}` : nodeDir;
    // No TTY under a service: tell pnpm so it doesn't abort when it wants to confirm purging node_modules.
    e.CI = "true";
    return e;
  };

  const viaNode = (script: string, kind: PnpmLauncher["kind"], argv: string[]): PnpmLauncher => ({
    command: execPath,
    args: [script, ...argv],
    kind,
    env: childEnv(),
  });

  const cmdShim = (shim: string): PnpmLauncher | null => {
    if (!P.isAbsolute(shim) || P.basename(shim).toLowerCase() !== "pnpm.cmd" || CMD_UNSAFE.test(shim) || !fs.exists(shim)) {
      return null;
    }
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${shim}" ${PNPM_INSTALL_ARGS.join(" ")}"`],
      kind: "cmd-shim",
      env: childEnv(),
      windowsVerbatimArguments: true,
    };
  };

  // (a) explicit override
  const override = envGet(env, "PRINTIO_PNPM_PATH");
  if (override) {
    const base = P.basename(override).toLowerCase();
    let found: PnpmLauncher | null = null;
    if (!P.isAbsolute(override)) rejected.push("PRINTIO_PNPM_PATH is not an absolute path");
    else if (!fs.exists(override)) rejected.push("PRINTIO_PNPM_PATH does not exist");
    else if (base === "pnpm.cjs") found = viaNode(override, "node-cjs", [...PNPM_INSTALL_ARGS]);
    else if (base === "pnpm.exe" || (!win && base === "pnpm")) {
      found = { command: override, args: [...PNPM_INSTALL_ARGS], kind: "exe", env: childEnv() };
    } else if (base === "pnpm.cmd" && win) found = cmdShim(override);
    if (found) return { launcher: found, rejected };
    if (rejected.length === 0) {
      rejected.push("PRINTIO_PNPM_PATH must point at pnpm.cjs, pnpm.cmd or pnpm.exe, with no quotes or shell characters");
    }
  }

  if (!win) {
    for (const dir of (envGet(env, "PATH") ?? "").split(":")) {
      if (!dir || !P.isAbsolute(dir)) continue;
      const exe = P.join(dir, "pnpm");
      if (fs.exists(exe)) return { launcher: { command: exe, args: [...PNPM_INSTALL_ARGS], kind: "exe", env: childEnv() }, rejected };
    }
    return { launcher: null, rejected };
  }

  // (b) global npm prefixes
  const prefixes: string[] = [];
  const add = (d: string | undefined) => {
    if (d && !prefixes.some((x) => x.toLowerCase() === d.toLowerCase())) prefixes.push(d);
  };
  add(P.join(envGet(env, "ProgramFiles") ?? "C:\\Program Files", "nodejs"));
  add(nodeDir);
  const appData = envGet(env, "APPDATA");
  if (appData) add(P.join(appData, "npm"));
  const usersDir = P.join(envGet(env, "SystemDrive") ?? "C:", "Users");
  for (const name of fs.listDir(usersDir)) add(P.join(usersDir, name, "AppData", "Roaming", "npm"));
  for (const dir of (envGet(env, "PATH") ?? "").split(";")) if (dir && P.isAbsolute(dir)) add(dir);

  for (const prefix of prefixes) {
    const cjs = P.join(prefix, "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (fs.exists(cjs)) return { launcher: viaNode(cjs, "node-cjs", [...PNPM_INSTALL_ARGS]), rejected };
  }
  // only a .cmd shim exists
  for (const prefix of prefixes) {
    const launcher = cmdShim(P.join(prefix, "pnpm.cmd"));
    if (launcher) return { launcher, rejected };
  }
  // corepack, last resort (ships next to node.exe)
  const corepack = P.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js");
  if (fs.exists(corepack)) {
    const l = viaNode(corepack, "corepack", ["pnpm", ...PNPM_INSTALL_ARGS]);
    l.env = { ...(l.env ?? {}), COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
    return { launcher: l, rejected };
  }
  return { launcher: null, rejected };
}

/** spawn with an argv array and no shell - same rule the SumatraPDF and PowerShell invocations follow (docs/architecture.md sec 10). */
export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  options: RunOptions = {},
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env ? { env: options.env } : {}),
        ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
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
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: stdout.slice(0, 4000),
        stderr: timedOut ? `${stderr.slice(0, 3800)}\n[timed out after ${timeoutMs}ms]` : stderr.slice(0, 4000),
      });
    });
  });
}

/** Production dependency set - the one place the real spawn/filesystem implementations are wired in. */
export function createSelfUpdateDeps(logger: Logger): SelfUpdateDeps {
  return { repoRoot: resolveRepoRoot(), logger, run: runCommand, hasGitCheckout: isGitCheckout };
}

/** Short commit hash of HEAD via a fixed argv, or "unknown" - purely informational, never fails the update. */
async function currentVersion(deps: SelfUpdateDeps): Promise<string> {
  try {
    const out = await deps.run("git", ["rev-parse", "--short", "HEAD"], deps.repoRoot, GIT_TIMEOUT_MS);
    const hash = out.stdout.trim();
    return out.exitCode === 0 && /^[0-9a-f]{4,40}$/i.test(hash) ? hash : "unknown";
  } catch {
    return "unknown";
  }
}

/** Restarts the sibling IPP gateway service. Never throws; returns null on success or a plain reason on failure. */
async function restartGateway(deps: SelfUpdateDeps): Promise<string | null> {
  if ((deps.platform ?? process.platform) !== "win32") {
    return "only Windows print servers run the gateway as a service.";
  }
  try {
    const out = await deps.run("powershell.exe", GATEWAY_RESTART_ARGS, deps.repoRoot, GATEWAY_RESTART_TIMEOUT_MS);
    if (out.exitCode === 0) return null;
    const detail = (out.stderr || out.stdout).trim();
    if (/cannot find any service|was not found|does not exist/i.test(detail)) {
      return "it is not installed on this machine.";
    }
    if (out.exitCode === null) return "restarting it timed out.";
    return `${detail.replace(/\s+/g, " ").slice(0, 200) || `exit code ${out.exitCode}`}.`;
  } catch (err) {
    return `${(err instanceof Error ? err.message : String(err)).slice(0, 200)}.`;
  }
}

/**
 * Runs the fixed update sequence and reports, precisely, what happened.
 * Never throws: every failure mode becomes a `SelfUpdateResult` the caller
 * acks back to the cloud, because a command handler that throws would ack a
 * generic "handler_exception" and tell the admin nothing useful.
 */
export async function performSelfUpdate(deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const { repoRoot, logger } = deps;

  if (!deps.hasGitCheckout(repoRoot)) {
    logger.warn("CHECK_FOR_UPDATE: this Agent is not running from a git checkout - cannot self-update", { repoRoot });
    return {
      updated: false,
      reason: "not_a_git_checkout",
      message:
        "This Agent isn't running from a git clone (most likely it was extracted from a downloaded ZIP), so it can't update itself. " +
        "To update it, run setup-agent.ps1 (double-click setup-agent.bat) on that machine, or re-install it from a git clone.",
      repoRoot,
    };
  }

  await reportProgress(deps, { step: "checking", message: "Checking this print server..." });

  // Find pnpm BEFORE touching anything: a missing pnpm must not leave newly
  // pulled code behind (the next press would then say "already up to date").
  const resolution = resolvePnpmLauncher({
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    execPath: deps.execPath ?? process.execPath,
    fs: deps.fs ?? realFs,
  });
  const launcher = resolution.launcher;
  if (!launcher) {
    logger.warn("CHECK_FOR_UPDATE: pnpm was not found", { rejected: resolution.rejected });
    return {
      updated: false,
      reason: "pnpm_not_found",
      failedStep: "checking",
      message:
        "pnpm was not found on that machine; set PRINTIO_PNPM_PATH in apps/agent/.env (the full path to pnpm.cjs, pnpm.cmd or pnpm.exe) and press Update again. " +
        "Nothing was changed." +
        (resolution.rejected.length ? ` (${resolution.rejected.join("; ")}.)` : ""),
      repoRoot,
    };
  }

  const before = await currentVersion(deps);

  await reportProgress(deps, { step: "downloading", message: "Downloading the update..." });
  let pull: CommandOutcome;
  try {
    // Hardcoded argv. `--ff-only` so an unattended update either advances
    // cleanly or refuses - it can never invent a merge commit on a machine
    // nobody is watching.
    pull = await deps.run("git", ["pull", "--ff-only"], repoRoot, GIT_TIMEOUT_MS);
  } catch (err) {
    logger.warn("CHECK_FOR_UPDATE: could not run git", { error: err instanceof Error ? err.message : String(err) });
    return {
      updated: false,
      reason: "git_unavailable",
      failedStep: "downloading",
      message:
        "git isn't available on that machine (or couldn't be started), so this Agent can't update itself. " +
        "Install git, or run setup-agent.ps1 on the machine to update it by hand.",
      repoRoot,
    };
  }

  if (pull.exitCode !== 0) {
    const detail = (pull.stderr || pull.stdout).trim().slice(0, 400);
    logger.warn("CHECK_FOR_UPDATE: git pull --ff-only did not succeed", { exitCode: pull.exitCode, detail });
    return {
      updated: false,
      reason: "git_failed",
      failedStep: "downloading",
      message:
        `Couldn't update: "git pull --ff-only" failed on that machine, so nothing was changed. ` +
        `Someone may need to look at the checkout directly. Details: ${detail || "(no output)"}`,
      repoRoot,
    };
  }

  const combined = `${pull.stdout}\n${pull.stderr}`;
  if (/already up[ -]to[ -]date/i.test(combined)) {
    logger.info("CHECK_FOR_UPDATE: already up to date - nothing to do");
    return {
      updated: false,
      reason: "already_up_to_date",
      message: "Already up to date - this Agent is running the latest code in its checkout.",
      repoRoot,
    };
  }

  const after = await currentVersion(deps);

  // The checkout just moved, so the dependency tree may have moved with it -
  // same reasoning (and the same command) as setup-agent.ps1 step 6's
  // "$repoWasUpdated -> re-run pnpm install". A no-op when nothing changed.
  await reportProgress(deps, { step: "installing", message: "Installing the update..." });
  let install: CommandOutcome;
  try {
    install = await deps.run(launcher.command, launcher.args, repoRoot, INSTALL_TIMEOUT_MS, {
      ...(launcher.env ? { env: launcher.env } : {}),
      ...(launcher.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    logger.warn("CHECK_FOR_UPDATE: could not run pnpm install after pulling", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      updated: false,
      reason: "install_failed",
      failedStep: "installing",
      message:
        `New code was pulled, but pnpm couldn't be started (${(err instanceof Error ? err.message : String(err)).slice(0, 160)}), so the Agent was NOT restarted. ` +
        "Set PRINTIO_PNPM_PATH in apps/agent/.env or run setup-agent.ps1 on that machine to finish the update.",
      repoRoot,
    };
  }

  if (install.exitCode !== 0) {
    const detail = (install.stderr || install.stdout).trim().slice(0, 400);
    logger.error("CHECK_FOR_UPDATE: pnpm install failed after pulling - not restarting", { detail });
    return {
      updated: false,
      reason: "install_failed",
      failedStep: "installing",
      message:
        `New code was pulled, but "pnpm install" failed, so the Agent was NOT restarted (it is still running the previous build). ` +
        `Run setup-agent.ps1 on that machine to finish the update. Details: ${detail || "(no output)"}`,
      repoRoot,
    };
  }

  // Pull and install both succeeded. Restart the sibling gateway service
  // BEFORE the caller schedules the Agent's own restart (see module header).
  const gatewayProblem = await restartGateway(deps);
  if (gatewayProblem) {
    logger.warn("CHECK_FOR_UPDATE: gateway service not restarted", { reason: gatewayProblem });
  }
  logger.warn("CHECK_FOR_UPDATE: updated and dependencies re-installed - a restart will follow");
  return {
    updated: true,
    reason: "updated",
    message:
      `Updated ${before} -> ${after}. ` +
      (gatewayProblem
        ? `The phone/print-dialog gateway was not restarted: ${gatewayProblem} `
        : "Restarted the gateway. ") +
      "The print server is restarting and will be back in about a minute.",
    repoRoot,
    gatewayRestarted: gatewayProblem === null,
    from: before,
    to: after,
  };
}

const COMMIT_SUBJECT_MAX = 140;

/**
 * CHECK_FOR_UPDATE with mode "check_only": is there something newer on the remote? Runs only fixed, read-only git
 * argv (fetch, rev-parse, rev-list, log) in the Agent's own checkout - nothing is pulled, merged, installed or
 * restarted, and nothing from the cloud reaches a process invocation. Never throws.
 */
export async function performUpdateCheck(deps: SelfUpdateDeps): Promise<UpdateCheckResult> {
  const { repoRoot, logger } = deps;
  if (!deps.hasGitCheckout(repoRoot)) {
    return {
      mode: "check_only",
      updateAvailable: false,
      reason: "not_a_git_checkout",
      message:
        "This print server was not installed from a git clone (most likely a downloaded ZIP), so it cannot check for or install updates by itself. " +
        "Run setup-agent.bat on that computer to update it.",
    };
  }
  const git = (args: readonly string[]) => deps.run("git", args, repoRoot, GIT_TIMEOUT_MS);
  try {
    const fetch = await git(["fetch", "--quiet"]);
    if (fetch.exitCode !== 0) {
      const detail = (fetch.stderr || fetch.stdout).trim().replace(/\s+/g, " ").slice(0, 200);
      logger.warn("update check: git fetch failed", { exitCode: fetch.exitCode, detail });
      return {
        mode: "check_only",
        updateAvailable: false,
        reason: "git_failed",
        message: `Could not reach GitHub to look for updates${detail ? ` (${detail})` : ""}.`,
      };
    }
    const current = await currentVersion(deps);
    const upstream = await git(["rev-parse", "--short", "@{u}"]);
    const latest = upstream.stdout.trim();
    if (upstream.exitCode !== 0 || !/^[0-9a-f]{4,40}$/i.test(latest)) {
      return {
        mode: "check_only",
        updateAvailable: false,
        reason: "git_failed",
        message: "This checkout is not tracking a GitHub branch, so there is nothing to compare against.",
      };
    }
    const count = await git(["rev-list", "--count", "HEAD..@{u}"]);
    const behind = count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) : NaN;
    if (!Number.isFinite(behind) || behind <= 0) {
      return { mode: "check_only", updateAvailable: false, reason: "up_to_date", message: "Up to date.", current, latest };
    }
    const subject = await git(["log", "-1", "--format=%s", "@{u}"]);
    const latestMessage = subject.exitCode === 0 ? subject.stdout.trim().replace(/\s+/g, " ").slice(0, COMMIT_SUBJECT_MAX) : "";
    return {
      mode: "check_only",
      updateAvailable: true,
      reason: "update_available",
      message: `An update is available (${behind} new ${behind === 1 ? "change" : "changes"}).`,
      current,
      latest,
      behind,
      ...(latestMessage ? { latestMessage } : {}),
    };
  } catch (err) {
    logger.warn("update check: could not run git", { error: err instanceof Error ? err.message : String(err) });
    return {
      mode: "check_only",
      updateAvailable: false,
      reason: "git_unavailable",
      message: "git is not available on that machine (or could not be started), so it cannot check for updates.",
    };
  }
}
