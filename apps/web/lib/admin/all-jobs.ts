/**
 * Pure helpers for the admin "All jobs" page (app/admin/jobs): which status
 * pill means which job states, the paging maths, and the search-string and
 * link builders. Unit tested in all-jobs.test.ts.
 */
import { routes } from "@/lib/routes";

export const ALL_JOBS_PAGE_SIZE = 25;
const MAX_PAGE = 200;
const MAX_SEARCH = 80;

export type JobFilter = "all" | "waiting" | "printing" | "done" | "failed" | "held";

export const JOB_FILTERS: { value: JobFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "printing", label: "Printing" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "held", label: "Held" },
];

const FILTER_STATUSES: Record<Exclude<JobFilter, "all">, string[]> = {
  waiting: ["pending_approval", "approved"],
  printing: ["claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"],
  done: ["completed"],
  failed: ["failed"],
  held: ["held"],
};

/** The job states a pill stands for, or null for All (no status filter). */
export function statusesForFilter(filter: JobFilter): string[] | null {
  return filter === "all" ? null : FILTER_STATUSES[filter];
}

export interface JobsQuery {
  status: JobFilter;
  q: string;
  page: number;
}

type Raw = string | string[] | undefined;
const first = (v: Raw): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

export function parseJobsQuery(params: { status?: Raw; q?: Raw; page?: Raw }): JobsQuery {
  const rawStatus = first(params.status);
  const status = JOB_FILTERS.some((f) => f.value === rawStatus) ? (rawStatus as JobFilter) : "all";
  const pageNum = Number.parseInt(first(params.page), 10);
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, MAX_PAGE) : 1;
  const q = first(params.q).trim().slice(0, MAX_SEARCH);
  return { status, q, page };
}

/** Inclusive row range for `.range(from, to)`: one extra row so the page knows whether older jobs exist. */
export function pageRange(page: number): { from: number; to: number } {
  const from = (Math.max(1, page) - 1) * ALL_JOBS_PAGE_SIZE;
  return { from, to: from + ALL_JOBS_PAGE_SIZE };
}

export function trimPage<T>(rows: T[]): { rows: T[]; hasOlder: boolean } {
  return { rows: rows.slice(0, ALL_JOBS_PAGE_SIZE), hasOlder: rows.length > ALL_JOBS_PAGE_SIZE };
}

/** Makes free text safe to drop into a PostgREST `or(...)` / `ilike` expression. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\"']/g, " ").replace(/\s+/g, " ").trim();
}

export function buildJobsHref(query: JobsQuery, change: Partial<JobsQuery> = {}): string {
  const next = { ...query, ...change };
  const params = new URLSearchParams();
  if (next.status !== "all") params.set("status", next.status);
  if (next.q) params.set("q", next.q);
  if (next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return qs ? `${routes.adminJobs}?${qs}` : routes.adminJobs;
}

export type JobTone = "neutral" | "live" | "success" | "warning" | "danger";

/** The status dot colour for a job: cyan while moving, yellow while waiting, magenta for a problem. */
export function jobStatusTone(status: string): JobTone {
  if (FILTER_STATUSES.printing.includes(status)) return "live";
  if (status === "completed") return "success";
  if (status === "failed" || status === "denied" || status === "rejected") return "danger";
  if (status === "held" || status === "pending_approval" || status === "approved") return "warning";
  return "neutral";
}
