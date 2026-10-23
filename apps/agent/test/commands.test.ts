import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_COMMANDS } from "@printio/shared";
import { handleCommand, type CommandHandlerDeps } from "../src/commands.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";
import type { RemoteCommandEnvelope } from "../src/cloud-client.js";

const logger = createLogger({ level: "error" });

function makeDeps(localStoragePath: string, overrides: Partial<CommandHandlerDeps> = {}): CommandHandlerDeps {
  return {
    localStoragePath,
    spoolerMonitor: {
      listQueueJobs: vi.fn(),
      getPrintJobStatus: vi.fn(),
      cancelPrintJob: vi.fn(async () => {}),
      pollUntilTerminal: vi.fn(),
    },
    printerManager: {
      discoverQueues: vi.fn(async () => []),
      restartSpooler: vi.fn(async () => {}),
    },
    jobQueue: createJobQueue(localStoragePath, logger),
    logger,
    refreshHeartbeatNow: vi.fn(async () => {}),
    scheduleServiceRestart: vi.fn(),
    // Default to the "can't self-update" answer, which is both the safe
    // default and the honest one for a test environment that is not a
    // controlled git checkout - individual tests override it.
    runSelfUpdate: vi.fn(async () => ({
      updated: false,
      reason: "not_a_git_checkout" as const,
      message: "not a git checkout",
      repoRoot: localStoragePath,
    })),
    ...overrides,
  };
}

describe("handleCommand - fixed allow-list", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "printio-agent-cmd-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unrecognized command without executing anything", async () => {
    const deps = makeDeps(dir);
    const envelope = { id: "c1", command: "DELETE_EVERYTHING", payload: {} } as unknown as RemoteCommandEnvelope;
    const result = await handleCommand(envelope, deps);
    expect(result.status).toBe("failed");
    expect(result.result).toEqual({ reason: "unknown_command" });
  });

  it("handles every command in the canonical REMOTE_COMMANDS set without throwing", async () => {
    for (const command of REMOTE_COMMANDS) {
      const deps = makeDeps(dir);
      const envelope: RemoteCommandEnvelope = { id: `c-${command}`, command, payload: {} };
      const result = await handleCommand(envelope, deps);
      expect(["completed", "failed"]).toContain(result.status);
    }
  });

  it("REFRESH_PRINTER_STATUS calls discoverQueues and refreshes the heartbeat", async () => {
    const deps = makeDeps(dir);
    await handleCommand({ id: "c1", command: "REFRESH_PRINTER_STATUS", payload: {} }, deps);
    expect(deps.printerManager.discoverQueues).toHaveBeenCalled();
    expect(deps.refreshHeartbeatNow).toHaveBeenCalled();
  });

  it("CANCEL_PRINT_JOB with no local record is a benign no-op, not a failure", async () => {
    const deps = makeDeps(dir);
    const result = await handleCommand({ id: "c1", command: "CANCEL_PRINT_JOB", payload: { jobId: "unknown-job" } }, deps);
    expect(result.status).toBe("completed");
    expect(deps.spoolerMonitor.cancelPrintJob).not.toHaveBeenCalled();
  });

  it("CANCEL_PRINT_JOB cancels using the exact queue+id pair recorded locally", async () => {
    const deps = makeDeps(dir);
    deps.jobQueue.upsertJob("job-1", {
      printerProfileId: "p1",
      state: "submitted_to_spooler",
      windowsQueueName: "Kyocera_Main",
      spoolerJobId: 7,
    });

    const result = await handleCommand({ id: "c1", command: "CANCEL_PRINT_JOB", payload: { jobId: "job-1" } }, deps);
    expect(result.status).toBe("completed");
    expect(deps.spoolerMonitor.cancelPrintJob).toHaveBeenCalledWith("Kyocera_Main", 7);
  });

  it("RESTART_PRINT_QUEUE restarts the spooler and re-checks status afterward", async () => {
    const deps = makeDeps(dir);
    const result = await handleCommand(
      { id: "c1", command: "RESTART_PRINT_QUEUE", payload: { printerProfileId: "p1" } },
      deps,
    );
    expect(result.status).toBe("completed");
    expect(deps.printerManager.restartSpooler).toHaveBeenCalled();
    expect(deps.printerManager.discoverQueues).toHaveBeenCalled();
  });

  it("RESTART_AGENT_SERVICE schedules a restart but does not restart synchronously", async () => {
    const deps = makeDeps(dir);
    const result = await handleCommand({ id: "c1", command: "RESTART_AGENT_SERVICE", payload: {} }, deps);
    expect(result.status).toBe("completed");
    expect(deps.scheduleServiceRestart).toHaveBeenCalled();
  });

  it("CLEAR_AGENT_TEMP_FILES only deletes files under localStoragePath/downloads and /tmp, never elsewhere", async () => {
    const downloadsDir = path.join(dir, "downloads");
    const tmpDir = path.join(dir, "tmp");
    mkdirSync(downloadsDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(downloadsDir, "job-1.pdf"), "fake pdf bytes");
    writeFileSync(path.join(tmpDir, "scratch.ps1"), "fake script");

    // A file OUTSIDE the temp-eligible subdirectories - must survive.
    const untouchable = path.join(dir, "job-queue-state.json");
    writeFileSync(untouchable, "{}");

    const deps = makeDeps(dir);
    const result = await handleCommand({ id: "c1", command: "CLEAR_AGENT_TEMP_FILES", payload: {} }, deps);

    expect(result.status).toBe("completed");
    expect(result.result?.filesRemoved).toBe(2);
    expect(existsSync(path.join(downloadsDir, "job-1.pdf"))).toBe(false);
    expect(existsSync(path.join(tmpDir, "scratch.ps1"))).toBe(false);
    expect(existsSync(untouchable)).toBe(true);
  });

  it("RESTART_PRINT_QUEUE reports failed (and does not claim success) when the spooler restart itself fails", async () => {
    const deps = makeDeps(dir, {
      printerManager: {
        discoverQueues: vi.fn(async () => []),
        restartSpooler: vi.fn(async () => {
          throw new Error("Restart-Service Spooler failed: access denied");
        }),
      },
    });

    const result = await handleCommand({ id: "c1", command: "RESTART_PRINT_QUEUE", payload: {} }, deps);

    expect(result.status).toBe("failed");
    expect(String(result.result?.reason)).toContain("access denied");
    // The whole point of the RESTART_PRINT_QUEUE handler re-checking status
    // afterward is that it never assumes the restart worked - if the restart
    // threw, there is nothing to re-check and nothing is reported as fine.
    expect(deps.refreshHeartbeatNow).not.toHaveBeenCalled();
  });

  it("CHECK_FOR_UPDATE on a non-git-checkout acks a clear, actionable answer instead of silently doing nothing", async () => {
    const deps = makeDeps(dir);
    const result = await handleCommand({ id: "c1", command: "CHECK_FOR_UPDATE", payload: {} }, deps);

    expect(result.status).toBe("completed");
    expect(result.result?.updated).toBe(false);
    expect(result.result?.reason).toBe("not_a_git_checkout");
    expect(typeof result.result?.message).toBe("string");
    // Critically: it must NOT restart the Agent when nothing was updated.
    expect(deps.scheduleServiceRestart).not.toHaveBeenCalled();
  });

  it("CHECK_FOR_UPDATE schedules a restart only after an update actually landed", async () => {
    const deps = makeDeps(dir, {
      runSelfUpdate: vi.fn(async () => ({
        updated: true,
        reason: "updated" as const,
        message: "Updated to the latest code.",
        repoRoot: dir,
      })),
    });

    const result = await handleCommand({ id: "c1", command: "CHECK_FOR_UPDATE", payload: {} }, deps);

    expect(result.status).toBe("completed");
    expect(result.result?.updated).toBe(true);
    expect(deps.scheduleServiceRestart).toHaveBeenCalled();
  });

  it("CHECK_FOR_UPDATE schedules the Agent's own restart LAST, after the update (and its gateway restart) has fully finished", async () => {
    const events: string[] = [];
    const deps = makeDeps(dir, {
      runSelfUpdate: vi.fn(async () => {
        events.push("update-started");
        await Promise.resolve();
        events.push("update-finished");
        return { updated: true, reason: "updated" as const, message: "Updated.", repoRoot: dir };
      }),
      scheduleServiceRestart: vi.fn(() => {
        events.push("agent-restart-scheduled");
      }),
    });

    await handleCommand({ id: "c1", command: "CHECK_FOR_UPDATE", payload: {} }, deps);

    expect(events).toEqual(["update-started", "update-finished", "agent-restart-scheduled"]);
  });

  it("CHECK_FOR_UPDATE never restarts when the update failed partway (pulled, but dependencies failed to install)", async () => {
    const deps = makeDeps(dir, {
      runSelfUpdate: vi.fn(async () => ({
        updated: false,
        reason: "install_failed" as const,
        message: "pnpm install failed",
        repoRoot: dir,
      })),
    });

    const result = await handleCommand({ id: "c1", command: "CHECK_FOR_UPDATE", payload: {} }, deps);

    expect(result.status).toBe("completed");
    expect(result.result?.reason).toBe("install_failed");
    expect(deps.scheduleServiceRestart).not.toHaveBeenCalled();
  });

  it("passes no part of a command payload into the self-update sequence (it takes no arguments at all)", async () => {
    const runSelfUpdate = vi.fn(async () => ({
      updated: false,
      reason: "already_up_to_date" as const,
      message: "Already up to date.",
      repoRoot: dir,
    }));
    const deps = makeDeps(dir, { runSelfUpdate });

    await handleCommand(
      // A hostile payload: if any of this could reach a process invocation,
      // this is where it would get in.
      { id: "c1", command: "CHECK_FOR_UPDATE", payload: { repo: "evil", args: ["--exec", "rm -rf /"] } },
      deps,
    );

    expect(runSelfUpdate).toHaveBeenCalledTimes(1);
    expect(runSelfUpdate).toHaveBeenCalledWith();
  });
});
