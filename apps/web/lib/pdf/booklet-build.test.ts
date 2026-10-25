import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { PDFDocument, StandardFonts } from "pdf-lib";
import { bookletSheetChoice, padAndImposeBooklet } from "./booklet-build";
import { IMPOSITION_GUTTER_PT, IMPOSITION_MARGIN_PT } from "./imposition";

async function letterDoc(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    for (let l = 0; l < 40; l++) p.drawText(`Line ${l + 1} of page ${i + 1}, body text in twelve point.`, { x: 72, y: 720 - l * 16, size: 12, font });
  }
  return doc.save();
}

describe("bookletSheetChoice", () => {
  it("is tabloid only when asked for exactly that, otherwise the regular Letter sheet", () => {
    expect(bookletSheetChoice("tabloid")).toBe("tabloid");
    for (const v of ["letter", "", null, undefined, "A3", 5]) expect(bookletSheetChoice(v)).toBe("letter");
  });
});

describe("padAndImposeBooklet sheet", () => {
  it("regular: a Letter sheet (landscape 792 x 612), as before", async () => {
    const r = await padAndImposeBooklet(await letterDoc(8), { paperSize: "letter", bindingSide: "left", fit: "fill" });
    const out = await PDFDocument.load(r.bytes);
    expect(out.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
    expect(out.getPageCount()).toBe(4);
  });

  it("11x17: an 11x17 sheet (landscape 1224 x 792), same page count and order for left and right binding", async () => {
    const src = await letterDoc(8);
    const left = await padAndImposeBooklet(src, { paperSize: "letter", bindingSide: "left", fit: "fill", sheet: "tabloid" });
    const right = await padAndImposeBooklet(src, { paperSize: "letter", bindingSide: "right", fit: "fill", sheet: "tabloid" });
    for (const r of [left, right]) {
      const out = await PDFDocument.load(r.bytes);
      expect(out.getPage(0).getSize()).toEqual({ width: 1224, height: 792 });
      expect(out.getPageCount()).toBe(4);
      expect(r.paddedPages).toBe(8);
    }
  });

  it("11x17 ignores the crop: a Letter page keeps its own margins, at about full size (never enlarged past the cell)", async () => {
    const { analyzePdfContent } = await import("./content-analysis");
    const r = await padAndImposeBooklet(await letterDoc(4), { paperSize: "letter", bindingSide: "left", fit: "fill", sheet: "tabloid" });
    const content = (await analyzePdfContent(r.bytes))![0]!;
    if (content.kind !== "content") throw new Error("no content");
    const cellW = 1224 / 2 - IMPOSITION_GUTTER_PT / 2 - IMPOSITION_MARGIN_PT;
    const cellH = 792 - 2 * IMPOSITION_MARGIN_PT;
    const scale = Math.min(cellW / 612, cellH / 792); // the whole page, margins included
    // The text's top edge sits where the whole-page scale puts it: 72pt down from the page top, scaled.
    const expectedTop = IMPOSITION_MARGIN_PT + (cellH - 792 * scale) / 2 + (792 - 72) * scale;
    expect(content.box.y1).toBeLessThanOrEqual(expectedTop + 15);
    expect(content.box.y1).toBeGreaterThan(expectedTop - 15);
    expect(scale).toBeGreaterThan(0.95); // really about full size
    expect(scale).toBeLessThanOrEqual(1);
  });
});
