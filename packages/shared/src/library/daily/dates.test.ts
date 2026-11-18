import { describe, expect, it } from "vitest";
import { localIsoDate, shiftIso } from "./dates";

describe("dates", () => {
  it("gives the local calendar date, not the UTC one", () => {
    expect(localIsoDate(new Date(2026, 10, 1, 23, 30))).toBe("2026-11-01");
    expect(localIsoDate(new Date(2026, 0, 5, 0, 5))).toBe("2026-01-05");
  });
  it("moves a date by days across month and year ends", () => {
    expect(shiftIso("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftIso("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftIso("2028-03-01", -1)).toBe("2028-02-29");
  });
});
