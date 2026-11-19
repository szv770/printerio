import { describe, expect, it } from "vitest";
import { isStandardMediaType, presetForMediaType, presetMediaTypeNames, PRINT_PRESETS, STANDARD_MEDIA_TYPES } from "./print-presets";

describe("print presets registry", () => {
  it("finds a preset ignoring case and surrounding spaces", () => {
    expect(presetForMediaType("  booklet - RIGHT edge, stapled ")?.id).toBe("booklet-right-stapled");
  });
  it("returns null for unknown, standard or non-string names", () => {
    expect(presetForMediaType("Booklet - up edge")).toBeNull();
    expect(presetForMediaType("stationery")).toBeNull();
    expect(presetForMediaType(undefined)).toBeNull();
  });
  it("lists every preset name once, short and unique", () => {
    const names = presetMediaTypeNames();
    expect(names).toHaveLength(PRINT_PRESETS.length);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const n of names) expect(n.length).toBeLessThan(40);
  });
  it("no preset name collides with a standard keyword", () => {
    for (const n of presetMediaTypeNames()) expect(isStandardMediaType(n)).toBe(false);
    expect(STANDARD_MEDIA_TYPES).toEqual(expect.arrayContaining(["stationery", "cardstock", "envelope", "labels", "transparency", "photographic"]));
  });
  it("recognises standard keywords case-insensitively", () => {
    expect(isStandardMediaType(" Cardstock ")).toBe(true);
    expect(isStandardMediaType("my-custom")).toBe(false);
  });
  it("booklet presets force a binding side and two sides; layout presets carry a layout and no booklet", () => {
    expect(presetForMediaType("Booklet - left edge, stapled")?.choices).toMatchObject({ booklet: "left", sides: "two" });
    const rep = presetForMediaType("Same page twice per sheet (cut in half)")!;
    expect(rep.choices.booklet).toBe("none");
    expect(rep.layout).toEqual({ kind: "repeat", cols: 2, rows: 1, pages: "each", marks: true });
  });
});
