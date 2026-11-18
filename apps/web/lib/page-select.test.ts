import { describe, expect, it } from "vitest";
import { parsePageRange } from "@printio/shared";
import { pagesToRangeText, quickSelection, rangeTextToPages, togglePage } from "./page-select";

describe("pagesToRangeText: what the form submits for a set of tapped pages", () => {
  it("writes runs as ranges and singles as numbers, in order", () => {
    expect(pagesToRangeText([1, 2, 3, 5, 8, 9, 10])).toBe("1-3, 5, 8-10");
    expect(pagesToRangeText([4])).toBe("4");
    expect(pagesToRangeText([2, 3])).toBe("2-3");
    expect(pagesToRangeText([1, 3, 5])).toBe("1, 3, 5");
  });
  it("sorts and drops duplicates and nonsense", () => {
    expect(pagesToRangeText([5, 1, 3, 2, 3, 0, -4, 2.5])).toBe("1-3, 5");
    expect(pagesToRangeText([])).toBe("");
  });
  it("round-trips through the real page-range parser", () => {
    for (const pages of [[1], [1, 2, 3], [2, 4, 6, 8], [1, 2, 5, 6, 7, 20], [10, 11]]) {
      const parsed = parsePageRange(pagesToRangeText(pages), 30);
      expect(parsed.ok && parsed.pages).toEqual(pages);
    }
  });
});

describe("rangeTextToPages: read what is typed back into taps", () => {
  it("reads a valid range", () => {
    expect(rangeTextToPages("1-3, 5", 10)).toEqual([1, 2, 3, 5]);
  });
  it("reads an empty box as no pages chosen, and an invalid one as none (the form shows the error itself)", () => {
    expect(rangeTextToPages("", 10)).toEqual([]);
    expect(rangeTextToPages("banana", 10)).toEqual([]);
    expect(rangeTextToPages("1-99", 10)).toEqual([]);
  });
});

describe("togglePage", () => {
  it("adds a page, and removes one that is already chosen", () => {
    expect(togglePage([1, 2], 5, 10)).toEqual([1, 2, 5]);
    expect(togglePage([1, 2, 5], 2, 10)).toEqual([1, 5]);
  });
  it("ignores a page outside the document", () => {
    expect(togglePage([1], 0, 10)).toEqual([1]);
    expect(togglePage([1], 11, 10)).toEqual([1]);
  });
});

describe("quickSelection shortcuts", () => {
  it.each([
    ["all", 5, [1, 2, 3, 4, 5]],
    ["none", 5, []],
    ["first", 5, [1]],
    ["last", 5, [5]],
    ["last3", 5, [3, 4, 5]],
    ["last3", 2, [1, 2]],
    ["first3", 5, [1, 2, 3]],
    ["odd", 6, [1, 3, 5]],
    ["even", 6, [2, 4, 6]],
    ["even", 1, []],
  ] as const)("%s of %i pages", (kind, total, want) => {
    expect(quickSelection(kind, total)).toEqual(want);
  });

  it("invert flips what is chosen", () => {
    expect(quickSelection("invert", 5, [1, 2])).toEqual([3, 4, 5]);
    expect(quickSelection("invert", 3, [])).toEqual([1, 2, 3]);
  });
});
