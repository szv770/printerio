import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildBookletPreviewPdf } from "./booklet-preview";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

async function docWith(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i + 1}`, { x: 72, y: 700, size: 12, font });
    p.drawText("Body text goes here", { x: 72, y: 100, size: 12, font });
  }
  return doc.save();
}

const base = { maxSizeBytes: 50_000_000, pageRangeText: null, paperSize: "letter", bindingSide: "left" as const, fit: "fill" as const };

describe("buildBookletPreviewPdf", () => {
  it("answers the padding question as 'with blank pages' and imposes N/2 landscape sides", async () => {
    const res = await buildBookletPreviewPdf(await docWith(5), base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.paddedPages).toBe(8);
    expect(res.blankPagesAdded).toBe(3);
    expect(res.sheets).toBe(2);
    const out = await PDFDocument.load(res.bytes);
    expect(out.getPageCount()).toBe(4);
    expect(out.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
  });

  it("applies the page range before padding", async () => {
    const res = await buildBookletPreviewPdf(await docWith(10), { ...base, pageRangeText: "1-4" });
    expect(res.ok && res.sourcePages).toBe(4);
    expect(res.ok && res.blankPagesAdded).toBe(0);
  });

  it("reports a bad page range against the pages field", async () => {
    const res = await buildBookletPreviewPdf(await docWith(4), { ...base, pageRangeText: "9-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors?.pageRange).toBeTruthy();
  });

  it("refuses something that is not a PDF", async () => {
    const res = await buildBookletPreviewPdf(new Uint8Array([1, 2, 3]), base);
    expect(res.ok).toBe(false);
  });

  it("refuses a file over the size limit", async () => {
    const res = await buildBookletPreviewPdf(await docWith(4), { ...base, maxSizeBytes: 100 });
    expect(res.ok).toBe(false);
  });

  it("stamps page 1 of the imposed result when asked", async () => {
    const plain = await buildBookletPreviewPdf(await docWith(4), base);
    const stamped = await buildBookletPreviewPdf(await docWith(4), { ...base, stamp: { text: "ABC-123", strength: "medium" } });
    expect(plain.ok && stamped.ok).toBe(true);
    if (plain.ok && stamped.ok) expect(stamped.bytes.byteLength).toBeGreaterThan(plain.bytes.byteLength);
  });
});
