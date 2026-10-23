import { describe, expect, it } from "vitest";
import {
  liveSummaryLine,
  summarizeAdvanced,
  summarizeFinishing,
  summarizePages,
  summarizePaperColor,
} from "./print-form-summary";

describe("liveSummaryLine", () => {
  it("joins pages, copies, sides and staple", () => {
    expect(liveSummaryLine({ pages: 12, copies: 2, sides: "two", staple: "top-left", booklet: "none" })).toBe(
      "12 pages · 2 copies · double-sided · stapled",
    );
  });
  it("uses singular words and single-sided", () => {
    expect(liveSummaryLine({ pages: 1, copies: 1, sides: "one", staple: "none", booklet: "none" })).toBe("1 page · 1 copy · single-sided");
  });
  it("says booklet instead of sides/staple", () => {
    expect(liveSummaryLine({ pages: 6, copies: 1, sides: "two", staple: "none", booklet: "left" })).toBe("6 pages · 1 copy · booklet");
  });
  it("leaves out the page count until a file is chosen", () => {
    expect(liveSummaryLine({ pages: null, copies: 3, sides: "two", staple: "none", booklet: "none" })).toBe("3 copies · double-sided");
  });
});

describe("summarizePages", () => {
  it("is all pages when empty", () => {
    expect(summarizePages("", 10)).toBe("All pages");
    expect(summarizePages("  ", null)).toBe("All pages");
  });
  it("echoes the range and counts when known", () => {
    expect(summarizePages("1-5, 8", 10, 6)).toBe("Pages 1-5, 8 (6 pages)");
  });
  it("echoes the range alone when the count is unknown", () => {
    expect(summarizePages("2-4", null, null)).toBe("Pages 2-4");
  });
});

describe("summarizeFinishing", () => {
  it("none", () => {
    expect(summarizeFinishing({ staple: "none", booklet: "none" })).toBe("No stapling or booklet");
  });
  it("staple corners", () => {
    expect(summarizeFinishing({ staple: "top-left", booklet: "none" })).toBe("Staple, top left");
    expect(summarizeFinishing({ staple: "top-right", booklet: "none" })).toBe("Staple, top right");
  });
  it("booklet edges", () => {
    expect(summarizeFinishing({ staple: "none", booklet: "left" })).toBe("Booklet, bound on the left");
    expect(summarizeFinishing({ staple: "none", booklet: "right" })).toBe("Booklet, bound on the right");
  });
});

describe("summarizePaperColor", () => {
  it("black and white with paper", () => {
    expect(summarizePaperColor({ colorMode: "bw", paperSize: "letter" })).toBe("Black & white, letter");
  });
  it("colour", () => {
    expect(summarizePaperColor({ colorMode: "color", paperSize: "11x17" })).toBe("Colour, 11x17");
  });
});

describe("summarizeAdvanced", () => {
  it("reports hole punch", () => {
    expect(summarizeAdvanced({ punchAvailable: true, punch: true })).toBe("Hole punch on");
    expect(summarizeAdvanced({ punchAvailable: true, punch: false })).toBe("Hole punch off");
  });
  it("falls back when there is no punch", () => {
    expect(summarizeAdvanced({ punchAvailable: false, punch: false })).toBe("Saved choices");
  });
});
