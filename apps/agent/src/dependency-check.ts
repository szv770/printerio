/**
 * Startup dependency validation - run once, at Agent startup, BEFORE the poll
 * loop ever asks the cloud for work (index.ts `runStart`, which is also the
 * only path the installed Windows Service takes: service-launcher.mjs forces
 * `argv[2] = "start"` and imports the same entry point).
 *
 * WHY THIS EXISTS. SumatraPDF is the single, unconditional submission path
 * for every print job this Agent will ever run (print-executor.ts, invoked
 * from orchestrator.ts's processJob for every job regardless of printer
 * profile - there is no per-profile "needs Sumatra" capability in this
 * codebase, see docs/architecture.md sec 9-10). Until this module existed,
 * "SumatraPDF isn't there / isn't runnable" was discovered at the worst
 * possible moment: mid-way through a real, approved, user-submitted job,
 * hours or days after setup, surfacing as a `failed` job with a confusing
 * spawn error. A dependency the Agent cannot work without at all belongs in
 * a startup check, not in a per-job error path.
 *
 * WHAT "INVOCABLE" MEANS HERE, precisely. This is deliberately NOT a
 * `Test-Path`-style file-existence check - a truncated download, an HTML
 * error page saved under an `.exe` name (which is exactly what this repo's
 * own pinned-download 404 bug produced once), a wrong-architecture build, or
 * an AV-quarantined stub all "exist". So this module:
 *
 *   1. reads the file's first bytes and requires the DOS/PE `MZ` magic, and
 *   2. actually starts the process and confirms Windows could load it.
 *
 * CONSERVATIVE BY CONSTRUCTION. A false positive here would take a working
 * Agent offline, which is strictly worse than the bug being fixed, so the
 * check only ever fails on unambiguous evidence: the executable could not be
 * found, is definitely not an executable image, or the OS refused to start
 * it. If the process starts AT ALL the check passes - the exit code, stdout,
 * stderr and even "it had to be killed on timeout" are all treated as
 * success, because they all prove the one thing being tested (Windows can
 * load and run this image). This module makes no claim about whether
 * SumatraPDF then prints correctly; only the physical validation checklist
 * (apps/agent/README.md) can establish that.
 *
 * THE PROBE ARGV IS HARMLESS BY CONSTRUCTION. `-print-to <synthetic queue>
 * -silent <nonexistent file>` cannot print anything: the input file does not
 * exist, so SumatraPDF fails before touching a printer, and `-silent`
 * suppresses the error dialog a GUI app would otherwise pop (which would
 * hang forever in a Windows Service's session-0 desktop). The queue name is
 * randomized per call specifically so it can never be confused with, or
 * collide with, a real queue somebody legitimately has - the placeholder-
 * collides-with-a-real-value bug class this whole module was written
 * alongside. A `-h`/`-help`-style probe was rejected for the opposite
 * reason: SumatraPDF answers those with a modal message box, which is a hang
 * (not an exit) under a service account.
 */

import { spawn } from "node:child_process";
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./logger.js";

/** How long the probe waits for the process to exit before killing it. Being killed still counts as a pass (see file header) - this only bounds how long startup can block. */
export const PROBE_TIMEOUT_MS = 10_000;

export type SumatraCheckStatus =
  /** The executable started. Nothing more is claimed. */
  | "ok"
  /** Nothing to run: no such file, or a bare name that isn't on PATH. */
  | "not_found"
  /** The file is there but is not a runnable Windows executable image (truncated/corrupt download, an HTML error page saved as .exe, wrong architecture, AV stub). */
  | "not_executable"
  /** The OS refused to start it for some other reason (permissions, AppLocker, ...). */
  | "cannot_start";

export interface SumatraCheckResult {
  ok: boolean;
  status: SumatraCheckStatus;
  /** Exactly what the Agent is configured to run - a full path, or the bare `SumatraPDF.exe` default resolved via PATH. */
  configuredPath: string;
  /** Where that resolved to on disk, when it could be resolved at all. */
  resolvedPath?: string;
  /** Plain-English, operator-facing detail. Safe to print verbatim. */
  detail: string;
  /** True when the probe process actually started (the thing being tested). */
  startedProcess: boolean;
  /** Set when the probe had to be killed on timeout - a pass, but worth saying out loud. */
  killedAfterTimeoutMs?: number;
}

export interface ProbeOutcome {
  /** True iff the OS started the process. Exit code is deliberately irrelevant. */
  started: boolean;
  exitCode?: number | null;
  /** Node's error code when the process could not be started at all (ENOENT, EACCES, EFTYPE/UNKNOWN, ...). */
  errorCode?: string;
  errorMessage?: string;
  killedAfterTimeoutMs?: number;
}

export interface SumatraCheckDeps {
  /** Starts the probe process and reports only whether the OS could run it. Injected so tests drive every branch without a real executable. */
  probe: (exePath: string, args: readonly string[], timeoutMs: number) => Promise<ProbeOutcome>;
  /** Reads the first `n` bytes of a file, or `undefined` if it can't be read at all. Injected for the same reason. */
  readHeadBytes: (filePath: string, n: number) => Buffer | undefined;
  /** Resolves a bare executable name against PATH (best effort - used for the operator-facing message, and to decide `not_found` before spawning). */
  resolveOnPath: (name: string) => string | undefined;
  /** Where to put the definitely-nonexistent PDF path the probe references. */
  scratchDir?: string;
}

/**
 * Classifies a failure-to-start into one of the honest statuses above. Pure,
 * so the mapping is unit-testable without producing each real OS error.
 *
 * `EFTYPE`/`UNKNOWN`/`ERROR_BAD_EXE_FORMAT` is what Windows reports for "this
 * file is not a valid Win32 application" - i.e. exactly the corrupt or
 * wrong-architecture download case, which is why it maps to
 * `not_executable` rather than a generic failure.
 */
export function classifyProbeFailure(errorCode: string | undefined, errorMessage = ""): SumatraCheckStatus {
  const code = (errorCode ?? "").toUpperCase();
  if (code === "ENOENT") return "not_found";
  if (code === "EFTYPE" || code === "ENOEXEC") return "not_executable";
  if (/not a valid (win32|windows) application|bad exe format/i.test(errorMessage)) return "not_executable";
  if (code === "EACCES" || code === "EPERM") return "cannot_start";
  return "cannot_start";
}

/** True iff `head` starts with the DOS `MZ` stub every Windows PE executable begins with. */
export function looksLikeWindowsExecutable(head: Buffer | undefined): boolean {
  if (!head || head.length < 2) return false;
  return head[0] === 0x4d && head[1] === 0x5a; // "MZ"
}

/** True for a value that must be resolved through PATH rather than treated as a filesystem path (the `SumatraPDF.exe` default). */
export function isBareExecutableName(configuredPath: string): boolean {
  return !configuredPath.includes("/") && !configuredPath.includes("\\");
}

/**
 * The probe argv. `nonexistentPdfPath` must not exist and `syntheticQueueName`
 * must be random enough that it cannot be a real queue - see the file header
 * for why both matter.
 */
export function buildProbeArgs(nonexistentPdfPath: string, syntheticQueueName: string): string[] {
  return ["-print-to", syntheticQueueName, "-silent", nonexistentPdfPath];
}

/** A queue name no real Windows print queue will ever be called, fresh per call so it can never collide with (or be mistaken for) somebody's real queue. */
export function syntheticProbeQueueName(): string {
  return `printio-startup-probe-${Math.random().toString(36).slice(2, 10)}`;
}

/** Production probe: spawn with an argv array, no shell, window hidden - the same rule every other process invocation in this package follows (docs/architecture.md sec 10). */
export function spawnProbe(
  exePath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exePath, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({ started: false, errorCode: e.code, errorMessage: e.message ?? String(err) });
      return;
    }

    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      // It started and is still running: that is a pass (see file header).
      // Kill it so startup is never blocked by a GUI app waiting on a
      // desktop nobody is looking at.
      try {
        child.kill();
      } catch {
        // Nothing useful to do - the outcome below is already decided.
      }
      finish({ started: true, killedAfterTimeoutMs: timeoutMs });
    }, timeoutMs);

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      finish({ started: false, errorCode: e.code, errorMessage: e.message });
    });
    child.on("exit", (code) => finish({ started: true, exitCode: code }));
  });
}

/** Production head-bytes reader. Never throws - an unreadable file is reported as `undefined`, which the caller treats as "not an executable image". */
export function readHeadBytes(filePath: string, n: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    if (!statSync(filePath).isFile()) return undefined;
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Best-effort PATH resolution for a bare executable name, mirroring what
 * libuv's own spawn does (PATH entries, then PATHEXT extensions on Windows).
 * Used for the operator-facing message and to distinguish `not_found` from a
 * real start failure before spawning.
 */
export function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? "";
  const dirs = rawPath.split(path.delimiter).filter((d) => d.trim() !== "");
  const extensions =
    platform === "win32" && path.extname(name) === ""
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.trim() !== "")
      : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Production dependency set - the one place the real spawn/filesystem implementations are wired in. */
export function createSumatraCheckDeps(): SumatraCheckDeps {
  return { probe: spawnProbe, readHeadBytes, resolveOnPath };
}

/**
 * Runs the startup check. Never throws: an unexpected failure inside the
 * check itself must not be indistinguishable from "SumatraPDF is broken", so
 * anything unexpected is reported as `cannot_start` with the real reason in
 * `detail`.
 */
export async function checkSumatraInvocable(
  configuredPath: string,
  deps: SumatraCheckDeps,
): Promise<SumatraCheckResult> {
  const bare = isBareExecutableName(configuredPath);

  // --- 1. Resolve it to something on disk -------------------------------
  let resolvedPath: string | undefined;
  if (bare) {
    resolvedPath = deps.resolveOnPath(configuredPath);
    if (!resolvedPath) {
      return {
        ok: false,
        status: "not_found",
        configuredPath,
        detail:
          `"${configuredPath}" is not on this machine's PATH, and PRINTIO_SUMATRA_PATH is not set to a full path. ` +
          "Nothing was found to run.",
        startedProcess: false,
      };
    }
  } else {
    resolvedPath = configuredPath;
    if (!existsSync(resolvedPath)) {
      return {
        ok: false,
        status: "not_found",
        configuredPath,
        resolvedPath,
        detail: `PRINTIO_SUMATRA_PATH points at "${configuredPath}", but no file exists there.`,
        startedProcess: false,
      };
    }
  }

  // --- 2. Is it actually an executable image? ----------------------------
  const head = deps.readHeadBytes(resolvedPath, 2);
  if (!looksLikeWindowsExecutable(head)) {
    return {
      ok: false,
      status: "not_executable",
      configuredPath,
      resolvedPath,
      detail:
        `"${resolvedPath}" exists but is not a Windows program - it does not begin with the "MZ" bytes every ` +
        ".exe starts with. This is what a half-finished download, or a web page saved under an .exe name, " +
        "looks like. Delete that file and install SumatraPDF again.",
      startedProcess: false,
    };
  }

  // --- 3. Can Windows actually start it? ---------------------------------
  const scratchDir = deps.scratchDir ?? os.tmpdir();
  const nonexistentPdf = path.join(
    scratchDir,
    `printio-startup-probe-${Math.random().toString(36).slice(2, 10)}-does-not-exist.pdf`,
  );
  const args = buildProbeArgs(nonexistentPdf, syntheticProbeQueueName());

  let outcome: ProbeOutcome;
  try {
    outcome = await deps.probe(resolvedPath, args, PROBE_TIMEOUT_MS);
  } catch (err) {
    return {
      ok: false,
      status: "cannot_start",
      configuredPath,
      resolvedPath,
      detail: `Could not run "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
      startedProcess: false,
    };
  }

  if (!outcome.started) {
    const status = classifyProbeFailure(outcome.errorCode, outcome.errorMessage);
    return {
      ok: false,
      status,
      configuredPath,
      resolvedPath,
      detail:
        status === "not_executable"
          ? `Windows refused to run "${resolvedPath}" - it is not a valid program for this machine ` +
            `(a corrupt download, or a build for the wrong processor architecture). Reported: ` +
            `${outcome.errorMessage ?? outcome.errorCode ?? "unknown error"}.`
          : `Windows could not start "${resolvedPath}": ${outcome.errorMessage ?? outcome.errorCode ?? "unknown error"}.`,
      startedProcess: false,
    };
  }

  return {
    ok: true,
    status: "ok",
    configuredPath,
    resolvedPath,
    detail:
      outcome.killedAfterTimeoutMs === undefined
        ? `SumatraPDF ran (exit code ${String(outcome.exitCode)} - expected, since the probe deliberately points it at a file that does not exist).`
        : `SumatraPDF started but did not exit within ${outcome.killedAfterTimeoutMs}ms, so the probe stopped it. It is runnable, which is what this check verifies.`,
    startedProcess: true,
    ...(outcome.killedAfterTimeoutMs === undefined ? {} : { killedAfterTimeoutMs: outcome.killedAfterTimeoutMs }),
  };
}

/**
 * The loud, visually distinct block printed when a startup dependency check
 * fails. Deliberately NOT a JSON log line: this is the one message whose
 * whole job is to be impossible to scroll past in a console window or a
 * support screenshot, so it matches setup-agent.ps1's `Show-StopMessage`
 * convention (a ruled block, a one-line verdict, then what/why/how-to-fix)
 * rather than logger.ts's structured format. The structured line still goes
 * to the log file alongside it - see index.ts.
 *
 * Pure and exported so the exact operator-facing wording is unit-testable.
 */
export function formatDependencyFailureBanner(result: SumatraCheckResult): string {
  const rule = "=".repeat(74);
  const configuredAs = isBareExecutableName(result.configuredPath)
    ? `PRINTIO_SUMATRA_PATH is not set, so the Agent looked for "${result.configuredPath}" on PATH`
    : `PRINTIO_SUMATRA_PATH=${result.configuredPath}`;

  return [
    "",
    rule,
    " PRINTIO PRINT AGENT DID NOT START - SumatraPDF is not usable",
    rule,
    "",
    `  What's wrong:   ${result.detail}`,
    `  Configured as:  ${configuredAs}`,
    "  Why it matters: every print job is sent to the printer through SumatraPDF.",
    "                  Without it, no job can ever succeed - so the Agent refuses",
    "                  to start rather than claim jobs it is guaranteed to fail.",
    "",
    "  How to fix it:  run apps\\agent\\scripts\\setup-agent.bat on this machine.",
    "                  It checks for SumatraPDF and offers to download the",
    "                  portable build (no admin rights needed) automatically.",
    "                  Or install it from https://www.sumatrapdfreader.org/ and",
    "                  set PRINTIO_SUMATRA_PATH in apps\\agent\\.env to its full path.",
    "                  See docs/agent-install.md 'Prerequisites'.",
    "",
    rule,
    "",
  ].join("\n");
}

/**
 * Runs every startup dependency check, logs the outcome, and reports whether
 * the Agent may proceed. Called from index.ts's `start` command (and
 * therefore also from the installed Windows Service, which runs the same
 * command - see file header).
 */
export async function verifyStartupDependencies(
  options: { sumatraPath: string; skip?: boolean },
  logger: Logger,
  deps: SumatraCheckDeps = createSumatraCheckDeps(),
): Promise<{ ok: boolean; sumatra?: SumatraCheckResult }> {
  if (options.skip) {
    logger.warn(
      "PRINTIO_SKIP_DEPENDENCY_CHECK is set - the startup SumatraPDF check was SKIPPED. " +
        "This is an escape hatch for a check that is wrong about a working machine; if printing then fails, " +
        "this is the first thing to unset.",
      { sumatraPath: options.sumatraPath },
    );
    return { ok: true };
  }

  const sumatra = await checkSumatraInvocable(options.sumatraPath, deps);
  if (sumatra.ok) {
    logger.info("startup dependency check passed: SumatraPDF is invocable", {
      configuredPath: sumatra.configuredPath,
      resolvedPath: sumatra.resolvedPath,
      detail: sumatra.detail,
    });
    return { ok: true, sumatra };
  }

  // Both: the banner so a human cannot miss it, and the structured line so it
  // lands in the log file the same way every other event does.
  console.error(formatDependencyFailureBanner(sumatra));
  logger.error("startup dependency check FAILED: SumatraPDF is not invocable - refusing to start", {
    status: sumatra.status,
    configuredPath: sumatra.configuredPath,
    resolvedPath: sumatra.resolvedPath,
    detail: sumatra.detail,
  });
  return { ok: false, sumatra };
}
