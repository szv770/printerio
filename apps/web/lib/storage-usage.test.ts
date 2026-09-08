import { describe, expect, it } from "vitest";
import { summarizeStorageUsage, type StorageJobRow } from "./storage-usage";

const settings = {
  retention_completed_days: 7,
  retention_rejected_days: 3,
  retention_failed_days: 7,
};

const NOW = new Date("2026-09-08T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function row(status: string, sizeBytes: number | string, ageDays: number): StorageJobRow {
  return { status, file_size_bytes: sizeBytes, updated_at: daysAgo(ageDays) };
}

describe("summarizeStorageUsage", () => {
  it("returns all-zero buckets for an organization with nothing stored", () => {
    const summary = summarizeStorageUsage([], settings, NOW);
    expect(summary.total).toEqual({ jobs: 0, bytes: 0 });
    expect(summary.cleanable).toEqual({ jobs: 0, bytes: 0 });
  });

  it("counts every row that still has files in the total", () => {
    const summary = summarizeStorageUsage([row("completed", 100, 1), row("pending_approval", 250, 1)], settings, NOW);
    expect(summary.total).toEqual({ jobs: 2, bytes: 350 });
  });

  it("never counts an in-flight or undecided job as cleanable, however old it is", () => {
    const rows = [
      row("pending_approval", 10, 400),
      row("approved", 20, 400),
      row("claimed", 30, 400),
      row("printing", 40, 400),
      row("draft", 50, 400),
    ];
    const summary = summarizeStorageUsage(rows, settings, NOW);
    expect(summary.cleanable).toEqual({ jobs: 0, bytes: 0 });
    expect(summary.active).toEqual({ jobs: 5, bytes: 150 });
  });

  it("splits terminal jobs by whether they are past their own window", () => {
    const rows = [
      row("completed", 100, 8), // past the 7-day completed window
      row("completed", 100, 2), // still inside it
      row("rejected", 10, 4), // past the 3-day rejected window
      row("rejected", 10, 1), // still inside it
    ];
    const summary = summarizeStorageUsage(rows, settings, NOW);
    expect(summary.cleanable).toEqual({ jobs: 2, bytes: 110 });
    expect(summary.withinRetention).toEqual({ jobs: 2, bytes: 110 });
  });

  it("applies each status group's OWN window, not one shared cutoff", () => {
    // 4 days old: past the 3-day rejected window, but not the 7-day completed one.
    const summary = summarizeStorageUsage([row("completed", 1, 4), row("cancelled", 2, 4)], settings, NOW);
    expect(summary.cleanableByGroup.rejected).toEqual({ jobs: 1, bytes: 2 });
    expect(summary.cleanableByGroup.completed).toEqual({ jobs: 0, bytes: 0 });
  });

  it("groups denied/cancelled/expired under the same window as rejected", () => {
    const rows = [row("denied", 1, 5), row("cancelled", 2, 5), row("expired", 4, 5), row("rejected", 8, 5)];
    const summary = summarizeStorageUsage(rows, settings, NOW);
    expect(summary.cleanableByGroup.rejected).toEqual({ jobs: 4, bytes: 15 });
  });

  it("handles file_size_bytes arriving as a string (Postgres bigint over PostgREST)", () => {
    const summary = summarizeStorageUsage([row("completed", "4194304", 30)], settings, NOW);
    expect(summary.total.bytes).toBe(4194304);
    expect(summary.cleanable.bytes).toBe(4194304);
  });

  it("treats an unparseable or negative size as zero rather than corrupting the total", () => {
    const summary = summarizeStorageUsage([row("completed", "not-a-number", 30), row("completed", -5, 30)], settings, NOW);
    expect(summary.total).toEqual({ jobs: 2, bytes: 0 });
  });

  it("keeps the buckets a partition of the total", () => {
    const rows = [row("completed", 100, 30), row("completed", 100, 1), row("printing", 100, 30), row("failed", 100, 30)];
    const summary = summarizeStorageUsage(rows, settings, NOW);
    expect(summary.active.jobs + summary.withinRetention.jobs + summary.cleanable.jobs).toBe(summary.total.jobs);
    expect(summary.active.bytes + summary.withinRetention.bytes + summary.cleanable.bytes).toBe(summary.total.bytes);
  });
});
