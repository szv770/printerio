import { describe, it, expect } from "vitest";
import {
  aggregateByUser,
  aggregateByDepartment,
  aggregateByPrinter,
  aggregateColorUsage,
  recentRejectedOrFailed,
  aggregatePagesByMonth,
  type ReportJobRow,
} from "./reports";

function job(overrides: Partial<ReportJobRow>): ReportJobRow {
  return {
    id: crypto.randomUUID(),
    createdBy: "user-1",
    department: null,
    colorMode: "bw",
    status: "completed",
    printerId: "printer-1",
    estimatedPhysicalSheets: 1,
    sourcePdfPages: 1,
    copies: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("aggregateByUser", () => {
  it("counts jobs and sums sheets only for jobs that actually printed", () => {
    const jobs = [
      job({ createdBy: "u1", estimatedPhysicalSheets: 5, status: "completed" }),
      job({ createdBy: "u1", estimatedPhysicalSheets: 3, status: "denied" }), // never printed
      job({ createdBy: "u2", estimatedPhysicalSheets: 2, status: "submitted_to_spooler" }),
    ];
    const result = aggregateByUser(jobs, (id) => `Label:${id}`);
    const u1 = result.find((r) => r.key === "u1")!;
    const u2 = result.find((r) => r.key === "u2")!;
    expect(u1.jobCount).toBe(2);
    expect(u1.sheets).toBe(5); // the denied job contributes 0 sheets
    expect(u2.sheets).toBe(2);
    expect(u1.label).toBe("Label:u1");
  });

  it("sorts busiest user first", () => {
    const jobs = [job({ createdBy: "quiet" }), job({ createdBy: "busy" }), job({ createdBy: "busy" })];
    const result = aggregateByUser(jobs, (id) => id);
    expect(result[0]!.key).toBe("busy");
  });
});

describe("aggregateByDepartment", () => {
  it("excludes jobs from users with no department set", () => {
    const jobs = [job({ department: "Science" }), job({ department: null })];
    const result = aggregateByDepartment(jobs);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("Science");
  });
});

describe("aggregateByPrinter", () => {
  it("groups by printer id and applies the label function", () => {
    const jobs = [job({ printerId: "p1" }), job({ printerId: "p1" }), job({ printerId: "p2" })];
    const result = aggregateByPrinter(jobs, (id) => `Printer ${id}`);
    expect(result[0]).toMatchObject({ key: "p1", label: "Printer p1", jobCount: 2 });
  });
});

describe("aggregateColorUsage", () => {
  it("splits color vs bw job counts and sheets", () => {
    const jobs = [
      job({ colorMode: "color", estimatedPhysicalSheets: 4 }),
      job({ colorMode: "bw", estimatedPhysicalSheets: 2 }),
      job({ colorMode: "bw", estimatedPhysicalSheets: 1, status: "failed" }), // 0 sheets
    ];
    const usage = aggregateColorUsage(jobs);
    expect(usage.color).toEqual({ jobCount: 1, sheets: 4 });
    expect(usage.bw).toEqual({ jobCount: 2, sheets: 2 });
  });
});

describe("recentRejectedOrFailed", () => {
  it("only includes denied/failed jobs, newest first, capped at the limit", () => {
    const jobs = [
      job({ id: "a", status: "completed", createdAt: "2026-03-01T00:00:00Z" }),
      job({ id: "b", status: "denied", createdAt: "2026-01-01T00:00:00Z" }),
      job({ id: "c", status: "failed", createdAt: "2026-02-01T00:00:00Z" }),
    ];
    const result = recentRejectedOrFailed(jobs, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("c"); // newest of the two denied/failed jobs
  });
});

describe("aggregatePagesByMonth", () => {
  it("sums usage across users within the same period, oldest period first", () => {
    const rows = [
      { period: "2026-02", pdfPagesUsed: 10, printedSidesUsed: 10, physicalSheetsUsed: 5, colorWeightedUsed: 5 },
      { period: "2026-01", pdfPagesUsed: 3, printedSidesUsed: 3, physicalSheetsUsed: 3, colorWeightedUsed: 3 },
      { period: "2026-01", pdfPagesUsed: 7, printedSidesUsed: 7, physicalSheetsUsed: 2, colorWeightedUsed: 2 },
    ];
    const result = aggregatePagesByMonth(rows);
    expect(result.map((r) => r.period)).toEqual(["2026-01", "2026-02"]);
    expect(result[0]).toMatchObject({ pdfPages: 10, physicalSheets: 5 });
  });
});
