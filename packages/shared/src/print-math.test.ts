import { describe, expect, it } from "vitest";
import { computeBookletPadding, computeCostCents, computePrintMath } from "./print-math.js";

describe("computePrintMath", () => {
  it("matches the spec's duplex example: 10 pages duplex 1 copy -> ~5 sheets", () => {
    const result = computePrintMath({ pageCount: 10, copies: 1, duplex: true, booklet: false });
    expect(result.printedSides).toBe(10);
    expect(result.physicalSheets).toBe(5);
  });

  it("matches the spec's copies example: 10 pages x 3 copies -> 30 printed sides", () => {
    const result = computePrintMath({ pageCount: 10, copies: 3, duplex: false, booklet: false });
    expect(result.printedSides).toBe(30);
    expect(result.physicalSheets).toBe(30);
  });

  it("simplex uses one sheet per page", () => {
    const result = computePrintMath({ pageCount: 7, copies: 1, duplex: false, booklet: false });
    expect(result.physicalSheets).toBe(7);
  });

  it("duplex with an odd page count rounds up to a full sheet", () => {
    const result = computePrintMath({ pageCount: 7, copies: 1, duplex: true, booklet: false });
    expect(result.physicalSheets).toBe(4);
  });

  it("booklet imposition uses 4 pages per sheet regardless of the duplex flag", () => {
    const result = computePrintMath({ pageCount: 8, copies: 2, duplex: false, booklet: true });
    expect(result.physicalSheets).toBe(4); // 8/4=2 sheets per copy * 2 copies
    expect(result.printedSides).toBe(16);
  });

  it("rejects non-positive input", () => {
    expect(() => computePrintMath({ pageCount: 0, copies: 1, duplex: false, booklet: false })).toThrow();
    expect(() => computePrintMath({ pageCount: 5, copies: 0, duplex: false, booklet: false })).toThrow();
  });
});

describe("computeBookletPadding", () => {
  it("matches the spec's example: 6 pages -> pad to 8 (add 2 blanks)", () => {
    const result = computeBookletPadding(6);
    expect(result.paddedPages).toBe(8);
    expect(result.blankPagesAdded).toBe(2);
    expect(result.needsPadding).toBe(true);
  });

  it("needs no padding when already a multiple of 4", () => {
    const result = computeBookletPadding(12);
    expect(result.paddedPages).toBe(12);
    expect(result.blankPagesAdded).toBe(0);
    expect(result.needsPadding).toBe(false);
  });
});

describe("computeCostCents", () => {
  const pricing = {
    bwPerSideCents: 2,
    colorPerSideCents: 12,
    paperSizeMultipliers: { "11x17": 1.5 },
    staplingFeeCentsPerCopy: 5,
    bookletFeeCentsPerCopy: 25,
  };

  it("returns null when no pricing is configured", () => {
    expect(
      computeCostCents({
        printedSides: 10,
        copies: 1,
        colorMode: "bw",
        paperSize: "letter",
        finishingStaple: false,
        finishingBooklet: false,
        pricing: null,
      }),
    ).toBeNull();
  });

  it("computes bw cost with no finishing", () => {
    const cents = computeCostCents({
      printedSides: 10,
      copies: 1,
      colorMode: "bw",
      paperSize: "letter",
      finishingStaple: false,
      finishingBooklet: false,
      pricing,
    });
    expect(cents).toBe(20); // 10 sides * 2c
  });

  it("applies paper size multiplier and stapling fee per copy", () => {
    const cents = computeCostCents({
      printedSides: 10,
      copies: 2,
      colorMode: "bw",
      paperSize: "11x17",
      finishingStaple: true,
      finishingBooklet: false,
      pricing,
    });
    // 10 sides * 2c * 1.5 = 30, + staple fee 5c * 2 copies = 10 -> 40
    expect(cents).toBe(40);
  });

  it("uses color rate when color is requested", () => {
    const cents = computeCostCents({
      printedSides: 4,
      copies: 1,
      colorMode: "color",
      paperSize: "letter",
      finishingStaple: false,
      finishingBooklet: false,
      pricing,
    });
    expect(cents).toBe(48); // 4 sides * 12c
  });
});
