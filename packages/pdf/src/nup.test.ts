import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildLayoutPdf, chooseOrientation, layoutSheetCount, layoutSheetGroups, NUP_PRESETS, planSheet, validateLayout, type PlanOptions, type Rect } from "./nup";

const LETTER = { width: 612, height: 792 };
const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({ cols: 2, rows: 2, gap: 10, margin: 14, order: "row", border: false, marks: false, ...over });
const pages = (n: number, size = LETTER) => Array.from({ length: n }, () => size);
const inside = (r: Rect, outer: Rect) => r.x >= outer.x - 1e-6 && r.y >= outer.y - 1e-6 && r.x + r.width <= outer.x + outer.width + 1e-6 && r.y + r.height <= outer.y + outer.height + 1e-6;

async function pdf(n: number, size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage(size).drawText(`P${i + 1}`, { x: 50, y: 700 });
  return doc.save();
}

describe("n-up grid geometry", () => {
  for (const per of [2, 4, 6, 9] as const) {
    it(`${per} per sheet: equal cells, inside the margins, pages kept inside their cells`, () => {
      const { cols, rows } = NUP_PRESETS[per];
      const sheet = chooseOrientation(LETTER, LETTER, { cols, rows, gap: 10, margin: 14 });
      const plan = planSheet(sheet.width, sheet.height, pages(per), opts({ cols, rows }));
      expect(plan.placements).toHaveLength(per);
      const printable: Rect = { x: 14, y: 14, width: sheet.width - 28, height: sheet.height - 28 };
      const cellW = (sheet.width - 28 - (cols - 1) * 10) / cols;
      const cellH = (sheet.height - 28 - (rows - 1) * 10) / rows;
      for (const p of plan.placements) {
        expect(p.cell.width).toBeCloseTo(cellW);
        expect(p.cell.height).toBeCloseTo(cellH);
        expect(inside(p.cell, printable)).toBe(true);
        expect(inside(p.rect, p.cell)).toBe(true);
        expect(p.scale).toBeLessThanOrEqual(1);
        // aspect kept
        expect(p.rect.width / p.rect.height).toBeCloseTo(612 / 792);
      }
    });
  }

  it("a margin below 14pt is raised to 14pt", () => {
    const plan = planSheet(612, 792, pages(1), opts({ cols: 1, rows: 1, margin: 0 }));
    expect(plan.placements[0]!.cell.x).toBe(14);
    expect(plan.placements[0]!.cell.y).toBe(14);
  });

  it("auto orientation: 2-up of portrait pages goes landscape, 4-up stays portrait, a forced choice wins", () => {
    expect(chooseOrientation(LETTER, LETTER, { cols: 2, rows: 1, gap: 8, margin: 14 }).landscape).toBe(true);
    expect(chooseOrientation(LETTER, LETTER, { cols: 2, rows: 2, gap: 8, margin: 14 }).landscape).toBe(false);
    expect(chooseOrientation(LETTER, LETTER, { cols: 2, rows: 1, gap: 8, margin: 14 }, "portrait").landscape).toBe(false);
  });

  it("row order fills left-to-right then down; column order fills top-to-bottom then right", () => {
    const row = planSheet(612, 792, pages(4), opts({ order: "row" })).placements;
    const col = planSheet(612, 792, pages(4), opts({ order: "column" })).placements;
    // page 2 (index 1): row order -> top right; column order -> bottom left
    expect(row[1]!.cell.x).toBeGreaterThan(row[0]!.cell.x);
    expect(row[1]!.cell.y).toBe(row[0]!.cell.y);
    expect(col[1]!.cell.x).toBe(col[0]!.cell.x);
    expect(col[1]!.cell.y).toBeLessThan(col[0]!.cell.y);
    expect(col[2]!.cell.x).toBeGreaterThan(col[0]!.cell.x);
  });

  it("too many pages for the sheet is a plain error", () => {
    expect(() => planSheet(612, 792, pages(1), opts({ cols: 12, rows: 12, gap: 40 }))).toThrow(/don't fit/);
  });

  it("optional borders are one rectangle per page", () => {
    expect(planSheet(612, 792, pages(3), opts({ border: true })).borders).toHaveLength(3);
    expect(planSheet(612, 792, pages(3), opts()).borders).toHaveLength(0);
  });
});

describe("sheet counts (what print math counts)", () => {
  const nup = (cols: number, rows: number) => ({ kind: "nup" as const, cols, rows });
  it("an odd number of pages fills the last sheet partly: 5 pages 4-up = 2 sides, 7 pages 2-up = 4", () => {
    expect(layoutSheetCount(nup(2, 2), 5)).toBe(2);
    expect(layoutSheetCount(nup(2, 1), 7)).toBe(4);
    expect(layoutSheetGroups(nup(2, 2), 5)).toEqual([[1, 2, 3, 4], [5]]);
  });
  it("repeat: each = one sheet per page, first/number = one sheet; copies are listed per page", () => {
    expect(layoutSheetCount({ kind: "repeat", cols: 2, rows: 2, pages: "each" }, 3)).toBe(3);
    expect(layoutSheetGroups({ kind: "repeat", cols: 2, rows: 2, pages: 2 }, 3)).toEqual([[2, 2, 2, 2]]);
    expect(layoutSheetGroups({ kind: "repeat", cols: 3, rows: 1, pages: "first" }, 3)).toEqual([[1, 1, 1]]);
  });
});

describe("step and repeat", () => {
  it("N copies per sheet from cols x rows, all the same page, at equal spacing", () => {
    const plan = planSheet(612, 792, pages(6, { width: 100, height: 50 }), opts({ cols: 2, rows: 3, gap: 14 }));
    expect(plan.placements).toHaveLength(6);
    const xs = [...new Set(plan.placements.map((p) => Math.round(p.cell.x)))];
    expect(xs).toHaveLength(2);
    expect(plan.placements.every((p) => p.scale === 1)).toBe(true); // small pages are not enlarged
  });

  it("cut marks: four corners x two ticks per copy, all in the gutter and margin, never touching a copy", () => {
    const plan = planSheet(612, 792, pages(6, { width: 150, height: 200 }), opts({ cols: 2, rows: 3, gap: 14, marks: true }));
    expect(plan.marks).toHaveLength(6 * 8);
    for (const m of plan.marks) {
      for (const [x, y] of [[m.x1, m.y1], [m.x2, m.y2]] as const) {
        expect(x).toBeGreaterThanOrEqual(14 - 1e-6);
        expect(x).toBeLessThanOrEqual(612 - 14 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(14 - 1e-6);
        expect(y).toBeLessThanOrEqual(792 - 14 + 1e-6);
        for (const p of plan.placements) {
          const r = p.rect;
          const touches = x > r.x - 1e-6 && x < r.x + r.width + 1e-6 && y > r.y - 1e-6 && y < r.y + r.height + 1e-6;
          expect(touches).toBe(false);
        }
      }
    }
  });

  it("marks force at least a 14pt gap, and a tick never reaches halfway across it", () => {
    const plan = planSheet(612, 792, pages(2, { width: 100, height: 100 }), opts({ cols: 2, rows: 1, gap: 2, marks: true }));
    const a = plan.placements[0]!.cell;
    const b = plan.placements[1]!.cell;
    expect(b.x - (a.x + a.width)).toBeCloseTo(14);
    for (const m of plan.marks) expect(Math.abs(m.x2 - m.x1)).toBeLessThanOrEqual(14 / 2);
  });

  it("copies must be 2 to 12, and a chosen page must exist", () => {
    expect(validateLayout({ kind: "repeat", cols: 1, rows: 1, pages: "first" })).toMatch(/2 and 12/);
    expect(validateLayout({ kind: "repeat", cols: 4, rows: 4, pages: "first" })).toMatch(/2 and 12/);
    expect(validateLayout({ kind: "repeat", cols: 2, rows: 2, pages: 9 }, 3)).toMatch(/Page 9/);
    expect(validateLayout({ kind: "repeat", cols: 2, rows: 2, pages: 2 }, 3)).toBeNull();
    expect(validateLayout({ kind: "nup", cols: 3, rows: 3, margin: -5 })).toMatch(/margin/);
  });
});

describe("building the PDF", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("5 pages 4-up gives 2 landscape-or-portrait sides on the job paper; 2-up of Letter pages is landscape", async () => {
    const four = await buildLayoutPdf(await pdf(5), { kind: "nup", cols: 2, rows: 2 }, "letter");
    expect(four.sheets).toBe(2);
    const doc = await PDFDocument.load(four.bytes);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const two = await PDFDocument.load((await buildLayoutPdf(await pdf(3), { kind: "nup", cols: 2, rows: 1 }, "letter")).bytes);
    expect(two.getPageCount()).toBe(2);
    expect(two.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
  });

  it("repeat of a chosen page is one side; 'each' is one side per page; same input gives the same bytes", async () => {
    const src = await pdf(3);
    const one = await buildLayoutPdf(src, { kind: "repeat", cols: 3, rows: 2, pages: 2, marks: true }, "letter");
    expect(one.sheets).toBe(1);
    expect((await buildLayoutPdf(src, { kind: "repeat", cols: 2, rows: 2, pages: "each" }, "a4")).sheets).toBe(3);
    const again = await buildLayoutPdf(src, { kind: "repeat", cols: 3, rows: 2, pages: 2, marks: true }, "letter");
    expect(Buffer.from(again.bytes).equals(Buffer.from(one.bytes))).toBe(true);
  });

  it("a blank page (no content stream) lays out without failing", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const r = await buildLayoutPdf(await doc.save(), { kind: "nup", cols: 2, rows: 1 }, "letter");
    expect(r.sheets).toBe(1);
  });
});
