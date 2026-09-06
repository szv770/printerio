import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobQueue, moreAdvancedState } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

describe("moreAdvancedState (reconciliation ordering)", () => {
  it("prefers a later happy-path state over an earlier one", () => {
    expect(moreAdvancedState("claimed", "submitted_to_spooler")).toBe("submitted_to_spooler");
    expect(moreAdvancedState("printing", "downloaded")).toBe("printing");
  });

  it("treats terminal states as maximally advanced", () => {
    expect(moreAdvancedState("submitted_to_spooler", "completed")).toBe("completed");
    expect(moreAdvancedState("cancelled", "downloading")).toBe("cancelled");
  });

  it("returns the same state when both sides agree", () => {
    expect(moreAdvancedState("printing", "printing")).toBe("printing");
  });

  it("treats failed as less advanced than the state that could precede a retry, but still real progress", () => {
    // A job that reached `printing` and then failed shouldn't be reported
    // as if it never got past `claimed`.
    expect(moreAdvancedState("failed", "claimed")).toBe("claimed");
  });
});

describe("createJobQueue", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "printio-agent-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists an upserted job to disk and reloads it", () => {
    const queue = createJobQueue(dir, logger);
    queue.upsertJob("job-1", { printerProfileId: "profile-1", state: "claimed" });

    const stateFile = path.join(dir, "job-queue-state.json");
    expect(existsSync(stateFile)).toBe(true);

    const queue2 = createJobQueue(dir, logger);
    const record = queue2.getJob("job-1");
    expect(record?.state).toBe("claimed");
    expect(record?.printerProfileId).toBe("profile-1");
  });

  it("survives a restart (simulated by creating a fresh instance against the same directory)", () => {
    const queue = createJobQueue(dir, logger);
    queue.upsertJob("job-1", { printerProfileId: "p1", state: "printing", windowsQueueName: "Kyocera_Main", spoolerJobId: 7 });

    const restarted = createJobQueue(dir, logger);
    const record = restarted.getJob("job-1");
    expect(record).toMatchObject({ state: "printing", windowsQueueName: "Kyocera_Main", spoolerJobId: 7 });
  });

  it("prunes a job from the active set once it reaches a terminal state (completed/cancelled)", () => {
    const queue = createJobQueue(dir, logger);
    queue.upsertJob("job-1", { printerProfileId: "p1", state: "claimed" });
    expect(queue.listActiveJobs()).toHaveLength(1);

    queue.upsertJob("job-1", { state: "completed" });
    expect(queue.listActiveJobs()).toHaveLength(0);
    expect(queue.getJob("job-1")).toBeUndefined();
  });

  it("keeps a `failed` job in the active set (a retry may re-claim the same jobId)", () => {
    const queue = createJobQueue(dir, logger);
    queue.upsertJob("job-1", { printerProfileId: "p1", state: "failed", lastError: "printer offline" });
    expect(queue.getJob("job-1")?.state).toBe("failed");
  });

  it("remembers a printerProfileId -> windowsQueueName mapping across restarts", () => {
    const queue = createJobQueue(dir, logger);
    queue.rememberQueueForProfile("profile-1", "Kyocera_Main_Booklet");

    const restarted = createJobQueue(dir, logger);
    expect(restarted.getQueueForProfile("profile-1")).toBe("Kyocera_Main_Booklet");
  });

  it("recovers from a corrupt state file instead of throwing", () => {
    const stateFile = path.join(dir, "job-queue-state.json");
    writeFileSync(stateFile, "{not valid json");
    const queue = createJobQueue(dir, logger);
    expect(queue.listActiveJobs()).toEqual([]);
  });

  it("writes the state file atomically (no leftover .tmp file after a write)", () => {
    const queue = createJobQueue(dir, logger);
    queue.upsertJob("job-1", { printerProfileId: "p1", state: "claimed" });
    const entries = readdirSync(dir);
    expect(entries.some((f) => f.includes(".tmp-"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "job-queue-state.json"), "utf8")).jobs["job-1"]).toBeDefined();
  });
});
