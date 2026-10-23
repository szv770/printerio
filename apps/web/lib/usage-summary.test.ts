import { describe, expect, it } from "vitest";
import { usageSummary } from "./usage-summary";

describe("usageSummary", () => {
  it("unlimited when there is no limit", () => {
    expect(usageSummary({ used: 12, limit: null, unit: "sheets" })).toEqual({
      headline: "12 sheets used this month",
      detail: "No limit is set for you.",
      pct: null,
      tone: "success",
    });
  });
  it("shows how much is left", () => {
    expect(usageSummary({ used: 40, limit: 100, unit: "sheets" })).toEqual({
      headline: "60 sheets left this month",
      detail: "You have used 40 of 100.",
      pct: 40,
      tone: "success",
    });
  });
  it("warns near the limit", () => {
    expect(usageSummary({ used: 75, limit: 100, unit: "sheets" }).tone).toBe("warning");
    expect(usageSummary({ used: 95, limit: 100, unit: "sheets" }).tone).toBe("danger");
  });
  it("says so when the limit is reached or passed", () => {
    expect(usageSummary({ used: 100, limit: 100, unit: "sheets" })).toMatchObject({ headline: "You have used all 100 sheets", pct: 100, tone: "danger" });
    expect(usageSummary({ used: 120, limit: 100, unit: "sheets" }).pct).toBe(100);
  });
  it("uses singular for one left", () => {
    expect(usageSummary({ used: 99, limit: 100, unit: "sheets" }).headline).toBe("1 sheet left this month");
  });
});
