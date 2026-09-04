import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_COMMANDS } from "@printos/shared";
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
    ...overrides,
  };
}

describe("handleCommand - fixed allow-list", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "printos-agent-cmd-test-"));
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
});
