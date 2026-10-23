import { describe, it, expect } from "vitest";
import {
  ALL_JOBS_PAGE_SIZE,
  JOB_FILTERS,
  buildJobsHref,
  jobStatusTone,
  pageRange,
  parseJobsQuery,
  sanitizeSearch,
  statusesForFilter,
  trimPage,
} from "./all-jobs";

describe("parseJobsQuery", () => {
  it("defaults to everything, page 1, no search", () => {
    expect(parseJobsQuery({})).toEqual({ status: "all", q: "", page: 1 });
  });
  it("accepts a known status and ignores unknown ones", () => {
    expect(parseJobsQuery({ status: "failed" }).status).toBe("failed");
    expect(parseJobsQuery({ status: "nonsense" }).status).toBe("all");
    expect(parseJobsQuery({ status: ["held", "failed"] }).status).toBe("held");
  });
  it("clamps the page to a sane positive integer", () => {
    expect(parseJobsQuery({ page: "3" }).page).toBe(3);
    expect(parseJobsQuery({ page: "0" }).page).toBe(1);
    expect(parseJobsQuery({ page: "-4" }).page).toBe(1);
    expect(parseJobsQuery({ page: "abc" }).page).toBe(1);
    expect(parseJobsQuery({ page: "9999999" }).page).toBe(200);
  });
  it("trims the search and caps its length", () => {
    expect(parseJobsQuery({ q: "  report  " }).q).toBe("report");
    expect(parseJobsQuery({ q: "x".repeat(300) }).q.length).toBe(80);
  });
});

describe("statusesForFilter", () => {
  it("returns null for All", () => expect(statusesForFilter("all")).toBeNull());
  it("maps each pill onto real job states", () => {
    expect(statusesForFilter("waiting")).toEqual(["pending_approval", "approved"]);
    expect(statusesForFilter("printing")).toEqual(["claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"]);
    expect(statusesForFilter("done")).toEqual(["completed"]);
    expect(statusesForFilter("failed")).toEqual(["failed"]);
    expect(statusesForFilter("held")).toEqual(["held"]);
  });
  it("lists the pills in the order the page shows them", () => {
    expect(JOB_FILTERS.map((f) => f.label)).toEqual(["All", "Waiting", "Printing", "Done", "Failed", "Held"]);
  });
});

describe("pageRange / trimPage", () => {
  it("uses a page size of 25", () => expect(ALL_JOBS_PAGE_SIZE).toBe(25));
  it("asks for one extra row so it knows if older jobs exist", () => {
    expect(pageRange(1)).toEqual({ from: 0, to: 25 });
    expect(pageRange(2)).toEqual({ from: 25, to: 50 });
  });
  it("trims the extra row and reports hasOlder", () => {
    const rows = Array.from({ length: 26 }, (_, i) => i);
    expect(trimPage(rows)).toEqual({ rows: rows.slice(0, 25), hasOlder: true });
    expect(trimPage([1, 2, 3])).toEqual({ rows: [1, 2, 3], hasOlder: false });
  });
});

describe("sanitizeSearch", () => {
  it("removes characters that would break a filter expression", () => {
    expect(sanitizeSearch("a,b(c)%d*e\\f")).toBe("a b c d e f");
  });
  it("collapses whitespace", () => expect(sanitizeSearch("  a   b ")).toBe("a b"));
});

describe("buildJobsHref", () => {
  it("omits defaults", () => {
    expect(buildJobsHref({ status: "all", q: "", page: 1 })).toBe("/admin/jobs");
  });
  it("keeps what is set", () => {
    expect(buildJobsHref({ status: "failed", q: "dana", page: 2 })).toBe("/admin/jobs?status=failed&q=dana&page=2");
  });
  it("lets one part change at a time", () => {
    expect(buildJobsHref({ status: "done", q: "", page: 1 }, { page: 3 })).toBe("/admin/jobs?status=done&page=3");
  });
});

describe("jobStatusTone", () => {
  it("colours by what the job is doing", () => {
    expect(jobStatusTone("printing")).toBe("live");
    expect(jobStatusTone("claimed")).toBe("live");
    expect(jobStatusTone("completed")).toBe("success");
    expect(jobStatusTone("failed")).toBe("danger");
    expect(jobStatusTone("denied")).toBe("danger");
    expect(jobStatusTone("pending_approval")).toBe("warning");
    expect(jobStatusTone("held")).toBe("warning");
    expect(jobStatusTone("approved")).toBe("warning");
    expect(jobStatusTone("cancelled")).toBe("neutral");
    expect(jobStatusTone("something_new")).toBe("neutral");
  });
});
