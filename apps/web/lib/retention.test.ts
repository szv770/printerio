import { describe, expect, it } from "vitest";
import { JOB_STATES } from "@printio/shared";
import { canOwnerPurgeFiles, retentionGroupForStatus, retentionWindows, type SelfPurgeCandidate } from "./retention";

describe("retentionGroupForStatus", () => {
  it("maps each terminal status to the window that governs it", () => {
    expect(retentionGroupForStatus("completed")).toBe("completed");
    expect(retentionGroupForStatus("rejected")).toBe("rejected");
    expect(retentionGroupForStatus("denied")).toBe("rejected");
    expect(retentionGroupForStatus("cancelled")).toBe("rejected");
    expect(retentionGroupForStatus("expired")).toBe("rejected");
    expect(retentionGroupForStatus("failed")).toBe("failed");
  });

  it("returns null for every state a job can still move forward from", () => {
    for (const status of ["draft", "pending_approval", "approved", "claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"]) {
      expect(retentionGroupForStatus(status)).toBeNull();
    }
  });

  it("classifies every state the job state machine defines, one way or the other", () => {
    // Guards against a new status being added to packages/shared without
    // anyone deciding whether its files are ever cleaned up.
    for (const status of JOB_STATES) {
      const group = retentionGroupForStatus(status);
      expect(group === null || ["completed", "rejected", "failed"].includes(group)).toBe(true);
    }
  });
});

describe("retentionWindows", () => {
  it("pairs each group with the organization's own configured day count", () => {
    const windows = retentionWindows({
      retention_completed_days: 7,
      retention_rejected_days: 3,
      retention_failed_days: 14,
    });
    expect(windows.map((w) => [w.group, w.days])).toEqual([
      ["completed", 7],
      ["rejected", 3],
      ["failed", 14],
    ]);
  });
});

describe("canOwnerPurgeFiles", () => {
  const base: SelfPurgeCandidate = {
    status: "completed",
    attempt_count: 0,
    max_attempts: 3,
    files_purged_at: null,
    original_file_path: "org/o1/jobs/j1/original.pdf",
  };

  it("allows a finished job the user owns", () => {
    expect(canOwnerPurgeFiles(base).ok).toBe(true);
    expect(canOwnerPurgeFiles({ ...base, status: "rejected" }).ok).toBe(true);
    expect(canOwnerPurgeFiles({ ...base, status: "cancelled" }).ok).toBe(true);
    expect(canOwnerPurgeFiles({ ...base, status: "expired" }).ok).toBe(true);
    expect(canOwnerPurgeFiles({ ...base, status: "denied" }).ok).toBe(true);
  });

  it("refuses an in-flight job - the Agent may still need the file", () => {
    for (const status of ["pending_approval", "approved", "claimed", "downloading", "printing", "submitted_to_spooler"]) {
      const result = canOwnerPurgeFiles({ ...base, status });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/hasn't finished/i);
    }
  });

  it("refuses a failed job that can still be retried, and allows one that cannot", () => {
    const retryable = canOwnerPurgeFiles({ ...base, status: "failed", attempt_count: 1, max_attempts: 3 });
    expect(retryable.ok).toBe(false);
    if (!retryable.ok) expect(retryable.reason).toMatch(/retried/i);

    expect(canOwnerPurgeFiles({ ...base, status: "failed", attempt_count: 3, max_attempts: 3 }).ok).toBe(true);
  });

  it("refuses a job whose file is already gone", () => {
    const result = canOwnerPurgeFiles({ ...base, files_purged_at: "2026-09-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already been deleted/i);
  });
});
