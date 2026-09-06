/**
 * Pure aggregation helpers for the admin Reports page (app/admin/reports).
 * Kept separate from the page/data-fetching so they're unit-testable without
 * a database - see lib/reports.test.ts. V1 is tables only (no charts): see
 * docs/architecture.md and the product-scalability review for why a fuller
 * reporting/analytics layer is deliberately out of scope for now.
 */

export interface ReportJobRow {
  id: string;
  createdBy: string;
  department: string | null;
  colorMode: string;
  status: string;
  printerId: string | null;
  estimatedPhysicalSheets: number;
  sourcePdfPages: number;
  copies: number;
  createdAt: string;
}

export interface MonthlyUsageRow {
  period: string; // "YYYY-MM"
  pdfPagesUsed: number;
  printedSidesUsed: number;
  physicalSheetsUsed: number;
  colorWeightedUsed: number;
}

export interface CountAndSheets {
  jobCount: number;
  sheets: number;
}

export interface LabeledCount extends CountAndSheets {
  key: string;
  label: string;
}

/** The set of statuses that consume no further action and represent a
 *  completed request cycle - used to decide what counts toward "sheets
 *  printed" totals (denied/pending jobs never printed anything). */
const COUNTS_TOWARD_SHEETS = new Set(["completed", "submitted_to_spooler", "printing"]);

function sheetsFor(job: ReportJobRow): number {
  return COUNTS_TOWARD_SHEETS.has(job.status) ? job.estimatedPhysicalSheets : 0;
}

function aggregateBy(jobs: ReportJobRow[], keyOf: (job: ReportJobRow) => string | null): Map<string, CountAndSheets> {
  const byKey = new Map<string, CountAndSheets>();
  for (const job of jobs) {
    const key = keyOf(job);
    if (key === null) continue;
    const existing = byKey.get(key) ?? { jobCount: 0, sheets: 0 };
    existing.jobCount += 1;
    existing.sheets += sheetsFor(job);
    byKey.set(key, existing);
  }
  return byKey;
}

/** Sorted by job count descending - the busiest users/departments/printers first. */
function toSortedLabeled(byKey: Map<string, CountAndSheets>, labelFor: (key: string) => string): LabeledCount[] {
  return Array.from(byKey.entries())
    .map(([key, counts]) => ({ key, label: labelFor(key), ...counts }))
    .sort((a, b) => b.jobCount - a.jobCount);
}

export function aggregateByUser(jobs: ReportJobRow[], labelFor: (userId: string) => string): LabeledCount[] {
  return toSortedLabeled(
    aggregateBy(jobs, (j) => j.createdBy),
    labelFor,
  );
}

export function aggregateByDepartment(jobs: ReportJobRow[]): LabeledCount[] {
  return toSortedLabeled(
    aggregateBy(jobs, (j) => j.department),
    (key) => key,
  );
}

export function aggregateByPrinter(jobs: ReportJobRow[], labelFor: (printerId: string) => string): LabeledCount[] {
  return toSortedLabeled(
    aggregateBy(jobs, (j) => j.printerId),
    labelFor,
  );
}

export interface ColorUsage {
  color: CountAndSheets;
  bw: CountAndSheets;
}

export function aggregateColorUsage(jobs: ReportJobRow[]): ColorUsage {
  const usage: ColorUsage = { color: { jobCount: 0, sheets: 0 }, bw: { jobCount: 0, sheets: 0 } };
  for (const job of jobs) {
    const bucket = job.colorMode === "color" ? usage.color : usage.bw;
    bucket.jobCount += 1;
    bucket.sheets += sheetsFor(job);
  }
  return usage;
}

/** Most-recent-first, capped so the page never renders an unbounded list. */
export function recentRejectedOrFailed(jobs: ReportJobRow[], limit = 50): ReportJobRow[] {
  return jobs
    .filter((j) => j.status === "denied" || j.status === "failed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export interface MonthlyTotal {
  period: string;
  pdfPages: number;
  printedSides: number;
  physicalSheets: number;
  colorWeighted: number;
}

/** monthly_usage is already one row per (user, period) - this sums across
 *  every user in the org to get an org-wide total per period, oldest first. */
export function aggregatePagesByMonth(rows: MonthlyUsageRow[]): MonthlyTotal[] {
  const byPeriod = new Map<string, MonthlyTotal>();
  for (const row of rows) {
    const existing = byPeriod.get(row.period) ?? {
      period: row.period,
      pdfPages: 0,
      printedSides: 0,
      physicalSheets: 0,
      colorWeighted: 0,
    };
    existing.pdfPages += row.pdfPagesUsed;
    existing.printedSides += row.printedSidesUsed;
    existing.physicalSheets += row.physicalSheetsUsed;
    existing.colorWeighted += row.colorWeightedUsed;
    byPeriod.set(row.period, existing);
  }
  return Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
}
