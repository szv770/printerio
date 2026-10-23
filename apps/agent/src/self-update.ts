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
 *   `git pull --ff-only` and `<pnpm> install` - spawned with `shell: false`,
 *   in one fixed working directory the Agent computes from its own module
 *   path. The CHECK_FOR_UPDATE payload is empty by contract
 *   (`RemoteCommandPayload` in @printio/shared) and this module never reads
 *   it: there is no branch name, remote, path, flag, or command string that
 *   can travel from the cloud into a process invocation here.
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
 * - **`git rev-parse --short HEAD`** (fixed argv) is run before and after the
 *   pull purely to tell the admin which version it moved from and to.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  | "install_failed";

export interface SelfUpdateResult {
  /** True only when the checkout actually advanced AND dependencies were re-installed successfully - i.e. a restart is warranted. */
  updated: boolean;
  reason: SelfUpdateReason;
  /** Plain-English, admin-facing - this string is what the console shows verbatim. */
  message: string;
  repoRoot: string;
  /** Only set when `updated`: whether the gateway service was restarted (false = a note explains why is in `message`). */
  gatewayRestarted?: boolean;
}

export interface SelfUpdateDeps {
  repoRoot: string;
  logger: Logger;
  /** Injected so tests can drive every branch without a real git remote; production passes `runCommand`. */
  run: (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandOutcome>;
  /** Injected for the same reason; production passes `isGitCheckout`. */
  hasGitCheckout: (repoRoot: string) => boolean;
  /** Injected so tests can exercise the non-Windows path; defaults to process.platform. */
  platform?: NodeJS.Platform;
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

/** spawn with an argv array and no shell - same rule the SumatraPDF and PowerShell invocations follow (docs/architecture.md sec 10). */
export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

  const before = await currentVersion(deps);

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
  let install: CommandOutcome;
  try {
    install = await deps.run(pnpmExecutable(), ["install"], repoRoot, INSTALL_TIMEOUT_MS);
  } catch (err) {
    logger.warn("CHECK_FOR_UPDATE: could not run pnpm install after pulling", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      updated: false,
      reason: "install_failed",
      message:
        "New code was pulled, but pnpm couldn't be started to re-install dependencies, so the Agent was NOT restarted. " +
        "Run setup-agent.ps1 on that machine to finish the update.",
      repoRoot,
    };
  }

  if (install.exitCode !== 0) {
    const detail = (install.stderr || install.stdout).trim().slice(0, 400);
    logger.error("CHECK_FOR_UPDATE: pnpm install failed after pulling - not restarting", { detail });
    return {
      updated: false,
      reason: "install_failed",
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
  };
}
