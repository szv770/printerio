import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_COMMANDS } from "@printio/shared";
import { handleCommand, type CommandHandlerDeps } from "../src/commands.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

function makeDeps(localStoragePath: string, overrides: Partial<CommandHandlerDeps> = {}): CommandHandlerDeps {
  return {
    localStoragePath,
    spoolerMonitor: { listQueueJobs: vi.fn(), getPrintJobStatus: vi.fn(), cancelPrintJob: vi.fn(async () => {}), pollUntilTerminal: vi.fn() },
    printerManager: { discoverQueues: vi.fn(async () => []), restartSpooler: vi.fn(async () => {}) },
    jobQueue: createJobQueue(localStoragePath, logger),
    logger,
    refreshHeartbeatNow: vi.fn(async () => {}),
    scheduleServiceRestart: vi.fn(),
    runSelfUpdate: vi.fn(),
    ...overrides,
  } as CommandHandlerDeps;
}

describe("handleCommand - GET_LOGS", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "printio-agent-getlogs-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is part of the shared allow-list", () => {
    expect(REMOTE_COMMANDS).toContain("GET_LOGS");
  });

  it("returns {files:[{name, lines}]} from the collector and ignores any payload", async () => {
    const collect = vi.fn(() => ({ files: [{ name: "agent/agent-2026-10-23.log", lines: ["a", "b"] }], notes: ["n"] }));
    const result = await handleCommand(
      { id: "c1", command: "GET_LOGS", payload: { path: "C:\\Windows\\System32\\config\\SAM", file: "../../x" } } as never,
      makeDeps(dir, { collectLogs: collect }),
    );
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({ files: [{ name: "agent/agent-2026-10-23.log", lines: ["a", "b"] }], notes: ["n"] });
    expect(collect).toHaveBeenCalledWith();
  });

  it("fails plainly, without leaking the error text, if reading the logs throws", async () => {
    const result = await handleCommand(
      { id: "c1", command: "GET_LOGS", payload: {} },
      makeDeps(dir, {
        collectLogs: () => {
          throw new Error("EACCES: C:\\secret\\path");
        },
      }),
    );
    expect(result).toEqual({ status: "failed", result: { reason: "could_not_read_logs" } });
  });

  it("the real reader works on the agent's own storage dir and masks secrets", async () => {
    mkdirSync(path.join(dir, "logs"), { recursive: true });
    writeFileSync(path.join(dir, "logs", `agent-${new Date().toISOString().slice(0, 10)}.log`), "hello Bearer abc.def\n");
    const result = await handleCommand({ id: "c1", command: "GET_LOGS", payload: {} }, makeDeps(dir));
    expect(result.status).toBe("completed");
    const files = (result.result as { files: Array<{ lines: string[] }> }).files;
    expect(files[0]!.lines).toEqual(["hello Bearer ***"]);
  });
});
