import { describe, it, expect } from "vitest";
import { groupQuotaReleases, filterAffectedRows, groupJobsByAttemptCount, jobsHoldingQuota, collectRetryableFailed } from "./cron-sweep";
import { usageAmountsForJob, type QuotaReleaseJobInput } from "./quota";

function releaseJob(overrides: Partial<QuotaReleaseJobInput>): QuotaReleaseJobInput {
  return {
    organizationId: "org-1",
    userId: "user-1",
    sourcePdfPages: 1,
    copies: 1,
    estimatedPrintedSides: 1,
    estimatedPhysicalSheets: 1,
    colorMode: "bw",
    ...overrides,
  };
}

describe("usageAmountsForJob", () => {
  it("weights color jobs 2x on the color-weighted metric, bw jobs 1x", () => {
    const color = usageAmountsForJob(releaseJob({ colorMode: "color", estimatedPhysicalSheets: 3 }));
    const bw = usageAmountsForJob(releaseJob({ colorMode: "bw", estimatedPhysicalSheets: 3 }));
    expect(color.colorWeighted).toBe(6);
    expect(bw.colorWeighted).toBe(3);
  });

  it("multiplies pdf pages by copies but leaves printed sides/sheets as estimated", () => {
    const amounts = usageAmountsForJob(releaseJob({ sourcePdfPages: 4, copies: 3, estimatedPrintedSides: 10 }));
    expect(amounts.pdfPages).toBe(12);
    expect(amounts.printedSides).toBe(10);
  });
});

describe("groupQuotaReleases", () => {
  it("sums amounts for jobs sharing the same organization+user", () => {
    const jobs = [
      releaseJob({ organizationId: "org-1", userId: "u1", estimatedPhysicalSheets: 5 }),
      releaseJob({ organizationId: "org-1", userId: "u1", estimatedPhysicalSheets: 2 }),
      releaseJob({ organizationId: "org-1", userId: "u2", estimatedPhysicalSheets: 9 }),
    ];
    const groups = groupQuotaReleases(jobs);
    expect(groups).toHaveLength(2);
    const u1 = groups.find((g) => g.userId === "u1")!;
    const u2 = groups.find((g) => g.userId === "u2")!;
    expect(u1.amounts.physicalSheets).toBe(7);
    expect(u2.amounts.physicalSheets).toBe(9);
  });

  it("keeps two organizations with the same user id as separate groups", () => {
    const jobs = [
      releaseJob({ organizationId: "org-1", userId: "shared-user", estimatedPhysicalSheets: 3 }),
      releaseJob({ organizationId: "org-2", userId: "shared-user", estimatedPhysicalSheets: 4 }),
    ];
    const groups = groupQuotaReleases(jobs);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.amounts.physicalSheets).sort()).toEqual([3, 4]);
  });

  it("returns an empty array for no jobs", () => {
    expect(groupQuotaReleases([])).toEqual([]);
  });
});

describe("filterAffectedRows", () => {
  it("keeps only candidates whose id was actually returned by the UPDATE", () => {
    const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = filterAffectedRows(candidates, ["b", "c"]);
    expect(result.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("drops a candidate claimed/transitioned by something else before the UPDATE ran", () => {
    const candidates = [{ id: "a" }, { id: "b" }];
    // Only "a" was actually affected - "b" changed state in between (e.g. an
    // Agent claimed it), so the batched UPDATE's WHERE clause excluded it.
    const result = filterAffectedRows(candidates, ["a"]);
    expect(result).toEqual([{ id: "a" }]);
  });

  it("returns an empty array when nothing was affected", () => {
    expect(filterAffectedRows([{ id: "a" }], [])).toEqual([]);
  });
});

describe("groupJobsByAttemptCount", () => {
  it("groups job ids by their shared current attempt_count", () => {
    const jobs = [
      { id: "j1", attemptCount: 0 },
      { id: "j2", attemptCount: 0 },
      { id: "j3", attemptCount: 1 },
    ];
    const groups = groupJobsByAttemptCount(jobs);
    expect(groups).toHaveLength(2);
    const zero = groups.find((g) => g.currentAttemptCount === 0)!;
    const one = groups.find((g) => g.currentAttemptCount === 1)!;
    expect(zero.ids.sort()).toEqual(["j1", "j2"]);
    expect(one.ids).toEqual(["j3"]);
  });

  it("returns an empty array for no jobs", () => {
    expect(groupJobsByAttemptCount([])).toEqual([]);
  });
});

describe("jobsHoldingQuota", () => {
  it("keeps only pending_approval jobs: held jobs never reserved quota", () => {
    const rows = [
      { id: "a", status: "pending_approval" },
      { id: "b", status: "held" },
    ];
    expect(jobsHoldingQuota(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("collectRetryableFailed (the failed-jobs selection pages past exhausted rows)", () => {
  type J = { id: string; attempt_count: number; max_attempts: number };
  const exhausted = (id: string): J => ({ id, attempt_count: 1, max_attempts: 1 });
  const open = (id: string): J => ({ id, attempt_count: 0, max_attempts: 1 });
  const pager = (rows: J[]) => async (offset: number, size: number) => rows.slice(offset, offset + size);

  it("is not starved by a full page of exhausted rows in front of newer retryable ones", async () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => exhausted(`x${i}`)), open("a"), open("b")];
    const out = await collectRetryableFailed(pager(rows), { limit: 5, pageSize: 3, maxPages: 10 });
    expect(out.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("stops at the limit, at maxPages, and when shouldStop says so", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => open(`o${i}`));
    expect(await collectRetryableFailed(pager(rows), { limit: 4, pageSize: 3, maxPages: 10 })).toHaveLength(4);
    expect(await collectRetryableFailed(pager(rows), { limit: 100, pageSize: 3, maxPages: 2 })).toHaveLength(6);
    let calls = 0;
    const out = await collectRetryableFailed(pager(rows), { limit: 100, pageSize: 3, maxPages: 10, shouldStop: () => ++calls > 1 });
    expect(out).toHaveLength(3);
  });
});
