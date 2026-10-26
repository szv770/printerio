import { describe, expect, it } from "vitest";
import { parsePageRange } from "./page-range";

const ok = (input: string, total: number) => {
  const r = parsePageRange(input, total);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(input)}: ${r.reason}`);
  return r.pages;
};
const bad = (input: string, total: number) => {
  const r = parsePageRange(input, total);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
};

describe("parsePageRange", () => {
  it("parses ranges and singles", () => {
    expect(ok("1-5, 8", 10)).toEqual([1, 2, 3, 4, 5, 8]);
    expect(ok("3", 10)).toEqual([3]);
    expect(ok(" 2 - 4 ", 10)).toEqual([2, 3, 4]);
    expect(ok("4-4", 10)).toEqual([4]);
  });
  it("supports open ends", () => {
    expect(ok("5-", 8)).toEqual([5, 6, 7, 8]);
    expect(ok("-3", 8)).toEqual([1, 2, 3]);
    expect(ok("8-", 8)).toEqual([8]);
  });
  it("de-duplicates, keeping the order given", () => {
    expect(ok("5,1-3,2,5", 10)).toEqual([5, 1, 2, 3]);
  });
  it("tolerates stray commas and whitespace between items", () => {
    expect(ok("1,,2, ,3", 5)).toEqual([1, 2, 3]);
    expect(ok("1,2,", 5)).toEqual([1, 2]);
  });
  it("rejects garbage", () => {
    for (const s of ["abc", "1-2-3", "1.5", "1;2", "--", "-", "1 2", "0x10", "1e2", "+3", "١٢", "1-a", "NaN", "Infinity"]) bad(s, 10);
  });
  it("rejects empty or blank input", () => {
    for (const s of ["", "   ", ",", " , ,"]) bad(s, 10);
  });
  it("rejects zero and negatives", () => {
    bad("0", 10);
    bad("0-3", 10);
    bad("-0", 10);
    bad("-5-3", 10);
  });
  it("rejects reversed ranges", () => bad("5-2", 10));
  it("rejects out-of-bounds", () => {
    bad("11", 10);
    bad("1-11", 10);
    bad("9-", 8);
    bad("99999999999999999999", 10);
  });
  it("rejects invalid totalPages", () => {
    bad("1", 0);
    bad("1", -1);
    bad("1", 1.5);
    bad("1", Number.NaN);
  });
  it("caps input length at 2000 (enough for every other page of a 400 page file)", () => {
    expect(parsePageRange("1,".repeat(1000), 5).ok).toBe(true); // exactly 2000 chars
    bad("1,".repeat(1001), 5);
    bad(" ".repeat(3000) + "1", 5);
    const everyOther = Array.from({ length: 400 }, (_, i) => i * 2 + 1).join(", ");
    expect(everyOther.length).toBeLessThanOrEqual(2000);
    expect(parsePageRange(everyOther, 800).ok).toBe(true);
  });
  it("is safe against odd input", () => {
    bad("__proto__", 5);
    bad("1-2\n3", 5) ;
    bad("1\u0000", 5);
    bad("<script>", 5);
    expect(ok("1-1000", 1000).length).toBe(1000);
  });
  it("returns pages never above totalPages", () => {
    expect(Math.max(...ok("1-", 7))).toBe(7);
  });
});
