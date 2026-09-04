import { describe, expect, it } from "vitest";
import {
  classifyJobStatus,
  findNewJobId,
  validateQueueName,
  validateJobId,
  type QueueJobSummary,
} from "../src/spooler-monitor.js";
import { SpoolerError } from "../src/errors.js";

describe("classifyJobStatus", () => {
  it("classifies clean-exit statuses as clean_exit", () => {
    expect(classifyJobStatus("Printed")).toBe("clean_exit");
    expect(classifyJobStatus("Printing, Complete")).toBe("clean_exit");
  });

  it("classifies known failure markers as failure", () => {
    for (const raw of ["Error", "Offline", "PaperOut", "PaperJam", "UserIntervention"]) {
      expect(classifyJobStatus(raw)).toBe("failure");
    }
  });

  it("classifies an in-progress status (e.g. Printing, Spooling) as in_progress", () => {
    expect(classifyJobStatus("Printing")).toBe("in_progress");
    expect(classifyJobStatus("Spooling")).toBe("in_progress");
  });

  it("is case-insensitive", () => {
    expect(classifyJobStatus("OFFLINE")).toBe("failure");
    expect(classifyJobStatus("printed")).toBe("clean_exit");
  });
});

describe("validateQueueName / validateJobId", () => {
  it("rejects empty/whitespace queue names", () => {
    expect(() => validateQueueName("")).toThrow(SpoolerError);
    expect(() => validateQueueName("   ")).toThrow(SpoolerError);
  });

  it("accepts a normal queue name", () => {
    expect(() => validateQueueName("Kyocera_Main")).not.toThrow();
  });

  it("rejects non-positive or non-integer job ids", () => {
    expect(() => validateJobId(0)).toThrow(SpoolerError);
    expect(() => validateJobId(-1)).toThrow(SpoolerError);
    expect(() => validateJobId(1.5)).toThrow(SpoolerError);
  });

  it("accepts a positive integer job id", () => {
    expect(() => validateJobId(42)).not.toThrow();
  });
});

describe("findNewJobId", () => {
  const before: QueueJobSummary[] = [{ id: 1, documentName: "other.pdf", submittedTime: "2026-01-01T00:00:00Z" }];

  it("returns null when nothing new appeared", () => {
    expect(findNewJobId(before, before, "mine.pdf")).toBeNull();
  });

  it("identifies the single new job id", () => {
    const after = [...before, { id: 2, documentName: "mine.pdf", submittedTime: "2026-01-01T00:00:05Z" }];
    const result = findNewJobId(before, after, "mine.pdf");
    expect(result).toEqual({ jobId: 2, confidence: "exact_name_match" });
  });

  it("prefers an exact document-name match among multiple new jobs", () => {
    const after = [
      ...before,
      { id: 2, documentName: "someone-elses.pdf", submittedTime: "2026-01-01T00:00:01Z" },
      { id: 3, documentName: "mine.pdf", submittedTime: "2026-01-01T00:00:02Z" },
    ];
    const result = findNewJobId(before, after, "mine.pdf");
    expect(result).toEqual({ jobId: 3, confidence: "exact_name_match" });
  });

  it("falls back to most-recent when there is no exact name match", () => {
    const after = [
      ...before,
      { id: 2, documentName: "unrelated-a.pdf", submittedTime: "2026-01-01T00:00:01Z" },
      { id: 3, documentName: "unrelated-b.pdf", submittedTime: "2026-01-01T00:00:05Z" },
    ];
    const result = findNewJobId(before, after, "mine.pdf");
    expect(result).toEqual({ jobId: 3, confidence: "most_recent" });
  });

  it("never considers a job present in `before` as new, even if the queue is scoped to one printer", () => {
    const result = findNewJobId(before, before, "other.pdf");
    expect(result).toBeNull();
  });
});
