import { describe, expect, it } from "vitest";
import { findQuotaForScope, usageAmountsForJob, usageForBasis, currentPeriod } from "./quota";

function quota(scopeType: string, scopeValue: string | null, limitValue = 100) {
  return { id: `${scopeType}:${scopeValue ?? "-"}`, scope_type: scopeType, scope_value: scopeValue, limit_value: limitValue };
}

describe("findQuotaForScope", () => {
  const rows = [
    quota("organization", null, 1000),
    quota("role", "student", 50),
    quota("department", "Science", 200),
    quota("user", "user-1", 25),
  ];

  it("finds the row for a scope that already has a quota", () => {
    expect(findQuotaForScope(rows, "role", "student")?.limit_value).toBe(50);
    expect(findQuotaForScope(rows, "user", "user-1")?.limit_value).toBe(25);
  });

  it("matches the org-wide row, whose scope_value is always null", () => {
    expect(findQuotaForScope(rows, "organization", null)?.limit_value).toBe(1000);
  });

  it("treats an empty-string scope_value the same as null, on either side", () => {
    expect(findQuotaForScope(rows, "organization", "")?.limit_value).toBe(1000);
    expect(findQuotaForScope([quota("organization", "")], "organization", null)).not.toBeNull();
  });

  it("does not match a different scope type carrying the same value", () => {
    expect(findQuotaForScope(rows, "department", "student")).toBeNull();
  });

  it("does not match a different value within the same scope type", () => {
    expect(findQuotaForScope(rows, "role", "staff")).toBeNull();
    expect(findQuotaForScope(rows, "user", "user-2")).toBeNull();
  });

  it("returns null when nothing is configured at all", () => {
    expect(findQuotaForScope([], "role", "student")).toBeNull();
  });

  it("is what stops a raised limit from being silently ignored", () => {
    // getApplicableQuotaLimit is most-restrictive-wins, so a second row for
    // the same scope with a HIGHER limit would never take effect - the admin
    // has to edit the existing row, which is what this lookup enables.
    const existing = findQuotaForScope(rows, "user", "user-1");
    expect(existing).not.toBeNull();
    expect(existing!.limit_value).toBeLessThan(500);
  });
});

describe("usageAmountsForJob", () => {
  const base = {
    organizationId: "org-1",
    userId: "user-1",
    sourcePdfPages: 4,
    copies: 3,
    estimatedPrintedSides: 6,
    estimatedPhysicalSheets: 3,
    colorMode: "bw",
  };

  it("charges pdf pages per copy, and sides/sheets as already computed", () => {
    const amounts = usageAmountsForJob(base);
    expect(amounts.pdfPages).toBe(12);
    expect(amounts.printedSides).toBe(6);
    expect(amounts.physicalSheets).toBe(3);
  });

  it("weights color at 2x physical sheets and b&w at 1x", () => {
    expect(usageAmountsForJob({ ...base, colorMode: "color" }).colorWeighted).toBe(6);
    expect(usageAmountsForJob(base).colorWeighted).toBe(3);
  });

  it("treats any non-'color' mode as b&w rather than throwing", () => {
    expect(usageAmountsForJob({ ...base, colorMode: "greyscale" }).colorWeighted).toBe(3);
  });
});

describe("usageForBasis", () => {
  const usage = { pdfPages: 10, printedSides: 8, physicalSheets: 4, colorWeighted: 8 };

  it("reads the metric the organization actually meters on", () => {
    expect(usageForBasis(usage, "pdf_pages")).toBe(10);
    expect(usageForBasis(usage, "printed_sides")).toBe(8);
    expect(usageForBasis(usage, "physical_sheets")).toBe(4);
    expect(usageForBasis(usage, "color_weighted")).toBe(8);
  });
});

describe("currentPeriod", () => {
  it("formats as YYYY-MM in UTC, zero-padded", () => {
    expect(currentPeriod(new Date("2026-03-09T12:00:00Z"))).toBe("2026-03");
    expect(currentPeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
  });

  it("uses UTC, not the server's local time, so a period never shifts by host", () => {
    // 2026-01-01T00:30Z is still December in UTC-5; the period must not be.
    expect(currentPeriod(new Date("2026-01-01T00:30:00Z"))).toBe("2026-01");
  });
});
