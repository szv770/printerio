import { describe, expect, it } from "vitest";
import { computeUniformCrop, computeCroppedSlotTransform, CROP_SAFETY_PAD_PT, MAX_CROP_FRACTION, type Box, type PageContent } from "./crop";

const LETTER: Box = { x0: 0, y0: 0, x1: 612, y1: 792 };
const content = (x0: number, y0: number, x1: number, y1: number): PageContent => ({ kind: "content", box: { x0, y0, x1, y1 } });
const w = (b: Box) => b.x1 - b.x0;
const h = (b: Box) => b.y1 - b.y0;

describe("computeUniformCrop", () => {
  it("crops a 1in-margin page to its content plus the safety pad", () => {
    const [crop] = computeUniformCrop([{ page: LETTER, content: content(72, 72, 540, 720) }])!;
    expect(crop).toEqual({ x0: 72 - CROP_SAFETY_PAD_PT, y0: 72 - CROP_SAFETY_PAD_PT, x1: 540 + CROP_SAFETY_PAD_PT, y1: 720 + CROP_SAFETY_PAD_PT });
  });

  it("uses the UNION of every page's content so a header/footer/page number survives on all pages", () => {
    const crops = computeUniformCrop([
      { page: LETTER, content: content(72, 72, 540, 720) },
      { page: LETTER, content: content(60, 30, 560, 760) }, // footer + header + wide table
      { page: LETTER, content: content(100, 200, 300, 400) },
    ])!;
    for (const c of crops) expect(c).toEqual(crops[0]);
    expect(crops[0]).toEqual({ x0: 60 - 4, y0: 30 - 4, x1: 560 + 4, y1: 760 + 4 });
  });

  it("ignores blank pages (padding) when taking the union, but still crops them identically", () => {
    const crops = computeUniformCrop([
      { page: LETTER, content: content(72, 72, 540, 720) },
      { page: LETTER, content: { kind: "blank" } },
    ])!;
    expect(crops[1]).toEqual(crops[0]);
  });

  it("returns null (no crop) when any page could not be analysed", () => {
    expect(
      computeUniformCrop([
        { page: LETTER, content: content(72, 72, 540, 720) },
        { page: LETTER, content: { kind: "unknown" } },
      ]),
    ).toBeNull();
  });

  it("returns null when every page is blank", () => {
    expect(computeUniformCrop([{ page: LETTER, content: { kind: "blank" } }])).toBeNull();
  });

  it("never crops outside the page: content past the page edge clamps to the page box", () => {
    const [crop] = computeUniformCrop([{ page: LETTER, content: content(-20, -5, 640, 800) }])!;
    expect(crop).toEqual(LETTER);
  });

  it("never crops more than 40% of a side, split in proportion", () => {
    const [crop] = computeUniformCrop([{ page: LETTER, content: content(250, 300, 350, 400) }])!;
    expect(w(crop!)).toBeCloseTo(612 * (1 - MAX_CROP_FRACTION), 6);
    expect(h(crop!)).toBeCloseTo(792 * (1 - MAX_CROP_FRACTION), 6);
    // the capped crop still contains the content
    expect(crop!.x0).toBeLessThanOrEqual(250);
    expect(crop!.x1).toBeGreaterThanOrEqual(350);
    expect(crop!.y0).toBeLessThanOrEqual(300);
    expect(crop!.y1).toBeGreaterThanOrEqual(400);
  });

  it("a full-bleed page is not cropped", () => {
    expect(computeUniformCrop([{ page: LETTER, content: content(0, 0, 612, 792) }])).toEqual([LETTER]);
  });

  it("applies the same per-side insets to pages of different sizes (landscape page)", () => {
    const land: Box = { x0: 0, y0: 0, x1: 792, y1: 612 };
    const crops = computeUniformCrop([
      { page: LETTER, content: content(72, 72, 540, 720) },
      { page: land, content: content(72, 72, 720, 540) },
    ])!;
    expect(crops[0]).toEqual({ x0: 68, y0: 68, x1: 544, y1: 724 });
    expect(crops[1]).toEqual({ x0: 68, y0: 68, x1: 792 - 72 + 4, y1: 612 - 72 + 4 });
  });
});

describe("computeCroppedSlotTransform", () => {
  const region = { x: 14, y: 14, width: 374.8, height: 584 };
  it("fits the crop to the cell, centered, touching the limiting edge", () => {
    const t = computeCroppedSlotTransform({ width: 476, height: 656 }, region);
    expect(t.scale).toBeCloseTo(Math.min(374.8 / 476, 584 / 656), 9);
    const sw = 476 * t.scale;
    const sh = 656 * t.scale;
    expect(t.x).toBeCloseTo(14 + (374.8 - sw) / 2, 9);
    expect(t.y).toBeCloseTo(14 + (584 - sh) / 2, 9);
  });
  it("enlarges a small crop up to 3x and no further", () => {
    expect(computeCroppedSlotTransform({ width: 50, height: 50 }, region).scale).toBe(3);
  });
});
