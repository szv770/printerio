import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { packPixels, rasterizePdf } from "./type3-rasterize";
import { hasType3Fonts, PICTURE_COPY_MAX_PAGES } from "./type3-fonts";

async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`page ${i + 1} שלום`.replace(/[^\x00-\x7f]/g, ""), { x: 72, y: 700, size: 24, font });
  return doc.save();
}

describe("rasterizePdf", () => {
  it("makes one same-size picture page per page, with no fonts and no text", async () => {
    const r = await rasterizePdf(await textPdf(2), { color: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBe(2);
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(hasType3Fonts(doc)).toBe(false);
    const raw = Buffer.from(r.bytes).toString("latin1");
    expect(raw).not.toContain("/Font");
    expect(raw).toContain("/DeviceGray");
  });

  it("uses RGB for a colour job", async () => {
    const r = await rasterizePdf(await textPdf(1), { color: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Buffer.from(r.bytes).toString("latin1")).toContain("/DeviceRGB");
  });

  it("refuses a file over the page limit instead of working on it", async () => {
    const r = await rasterizePdf(await textPdf(PICTURE_COPY_MAX_PAGES + 1), { color: false });
    expect(r.ok).toBe(false);
  });

  it("returns a failure (never throws) for bytes that are not a PDF", async () => {
    const r = await rasterizePdf(new Uint8Array([1, 2, 3]), { color: false });
    expect(r.ok).toBe(false);
  });
});

describe("packPixels", () => {
  it("composites on white and converts to grey", () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    expect(Array.from(packPixels(rgba, 3, false))).toEqual([0, 255, 255]);
  });
  it("keeps three channels for colour", () => {
    expect(Array.from(packPixels(new Uint8ClampedArray([10, 20, 30, 255]), 1, true))).toEqual([10, 20, 30]);
  });
});
