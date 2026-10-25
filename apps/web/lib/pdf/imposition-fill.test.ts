import { describe, expect, it, vi } from "vitest";

// The first call loads pdfjs (a large module); allow for a cold start.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { PDFDocument, StandardFonts, PDFArray, PDFRawStream, decodePDFRawStream, type PDFPage } from "pdf-lib";
import { imposeBookletPdf, IMPOSITION_GUTTER_PT, IMPOSITION_MARGIN_PT } from "./imposition";
import { analyzePdfContent } from "./content-analysis";

const LETTER = { width: 612, height: 792 };

/** A Word / Google Docs style export: Letter, 1in side margins, 12pt body, a header and a page number. */
async function wordLikeDoc(pageCount: number, size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [w, h] = size;
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([w, h]);
    page.drawText("Quarterly report - draft", { x: 72, y: h - 40, size: 9, font });
    for (let line = 0; line < 44; line++) {
      page.drawText(`Line ${line + 1} of body text on page ${i + 1}, set in twelve point type.`, { x: 72, y: h - 72 - line * 14.5, size: 12, font });
    }
    page.drawText(String(i + 1), { x: w / 2, y: 36, size: 10, font });
  }
  return doc.save();
}

function content(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const streams: PDFRawStream[] =
    contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => doc.context.lookup(contents.get(i)) as PDFRawStream) : contents ? [contents as PDFRawStream] : [];
  return streams.map((s) => new TextDecoder("latin1").decode(decodePDFRawStream(s).decode())).join("\n");
}

/** The product of the cm `a` components in each `q ... Do ... Q` block: the true drawn scale per slot. */
function drawnScales(text: string): number[] {
  const out: number[] = [];
  for (const block of text.split(/\bQ\b/)) {
    if (!/\bDo\b/.test(block)) continue;
    let s = 1;
    for (const m of block.matchAll(/(-?[\d.]+)\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+cm/g)) s *= parseFloat(m[1]!);
    out.push(s);
  }
  return out;
}

async function scalesOf(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().flatMap((p) => drawnScales(content(doc, p)));
}

const CELL_W = LETTER.height / 2 - IMPOSITION_GUTTER_PT / 2 - IMPOSITION_MARGIN_PT;
const CELL_H = LETTER.width - 2 * IMPOSITION_MARGIN_PT;


describe("imposeBookletPdf fit: fill", () => {
  it("makes a 1in-margin Letter document fill at least 85% of the cell's limiting dimension", async () => {
    const padded = await wordLikeDoc(8);
    const before = await imposeBookletPdf(padded, LETTER, "left", { fit: "keep" });
    const after = await imposeBookletPdf(padded, LETTER, "left", { fit: "fill" });

    const fillOf = async (bytes: Uint8Array) => {
      const res = (await analyzePdfContent(bytes))!;
      const c = res[0]!;
      if (c.kind !== "content") throw new Error("no content");
      // Both slots are centered in their cells, so the content width of one slot follows from the left ink edge.
      const w = CELL_W - 2 * (c.box.x0 - IMPOSITION_MARGIN_PT);
      const h = c.box.y1 - c.box.y0;
      return Math.max(w / CELL_W, h / CELL_H);
    };

    const fillBefore = await fillOf(before);
    const fillAfter = await fillOf(after);
    expect(fillAfter).toBeGreaterThanOrEqual(0.85);
    expect(fillAfter).toBeGreaterThan(fillBefore * 1.15);
    expect(fillAfter).toBeLessThanOrEqual(1.0001); // never outside the cell
  });

  it("uses one scale for every page (consistent text size), larger than the keep-margins scale", async () => {
    const padded = await wordLikeDoc(8);
    const keep = await scalesOf(await imposeBookletPdf(padded, LETTER, "left", { fit: "keep" }));
    const fill = await scalesOf(await imposeBookletPdf(padded, LETTER, "left", { fit: "fill" }));
    expect(fill).toHaveLength(8);
    for (const s of fill) expect(s).toBeCloseTo(fill[0]!, 9);
    expect(fill[0]!).toBeGreaterThan(keep[0]! * 1.15);
  });

  it("left and right binding use the identical scale (only the slots are mirrored)", async () => {
    const padded = await wordLikeDoc(8);
    const left = await scalesOf(await imposeBookletPdf(padded, LETTER, "left", { fit: "fill" }));
    const right = await scalesOf(await imposeBookletPdf(padded, LETTER, "right", { fit: "fill" }));
    expect(right).toEqual(left);
  });

  it("keeps a header and a page number inside the cell on every page (content is never cut)", async () => {
    const padded = await wordLikeDoc(4);
    const imposed = await imposeBookletPdf(padded, LETTER, "left", { fit: "fill" });
    const res = (await analyzePdfContent(imposed))!;
    for (const c of res) {
      if (c.kind !== "content") continue;
      expect(c.box.x0).toBeGreaterThanOrEqual(IMPOSITION_MARGIN_PT - 0.5);
      expect(c.box.x1).toBeLessThanOrEqual(LETTER.height - IMPOSITION_MARGIN_PT + 0.5);
      expect(c.box.y0).toBeGreaterThanOrEqual(IMPOSITION_MARGIN_PT - 0.5);
      expect(c.box.y1).toBeLessThanOrEqual(LETTER.width - IMPOSITION_MARGIN_PT + 0.5);
    }
  });

  it("fit keep reproduces the previous output (same drawn scales and page content as the default call)", async () => {
    const padded = await wordLikeDoc(8);
    const a = await imposeBookletPdf(padded, LETTER, "left");
    const b = await imposeBookletPdf(padded, LETTER, "left", { fit: "keep" });
    const docA = await PDFDocument.load(a);
    const docB = await PDFDocument.load(b);
    expect(docB.getPageCount()).toBe(docA.getPageCount());
    docA.getPages().forEach((p, i) => expect(content(docB, docB.getPage(i))).toBe(content(docA, p)));
    // and the old full-page scale: Letter page into a statement cell
    expect((await scalesOf(b))[0]).toBeCloseTo(Math.min(CELL_W / 612, CELL_H / 792), 9);
  });

  it("falls back to the full page (old behaviour) for blank documents", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([612, 792]);
    const bytes = await doc.save();
    const keep = await scalesOf(await imposeBookletPdf(bytes, LETTER, "left", { fit: "keep" }));
    const fill = await scalesOf(await imposeBookletPdf(bytes, LETTER, "left", { fit: "fill" }));
    expect(fill).toEqual(keep);
  });

  it("works for an A4 document and a landscape page without cutting anything", async () => {
    const a4 = await wordLikeDoc(4, [595.28, 841.89]);
    const imposed = await imposeBookletPdf(a4, LETTER, "left", { fit: "fill" });
    expect((await PDFDocument.load(imposed)).getPageCount()).toBe(4 / 2);
    const scales = await scalesOf(imposed);
    for (const s of scales) expect(s).toBeCloseTo(scales[0]!, 9);
  });

  it("mixed sizes: every page gets the biggest scale that fits, and an edge-to-edge scan of another size does not shrink the normal pages", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const wordPage = (n: number) => {
      const page = doc.addPage([612, 792]);
      for (let line = 0; line < 40; line++) page.drawText(`Line ${line + 1} of page ${n}, body text in twelve point.`, { x: 72, y: 720 - line * 16, size: 12, font });
    };
    wordPage(1);
    wordPage(2);
    wordPage(3);
    const scan = doc.addPage([842, 595]); // an A4-landscape scan: ink to every edge
    scan.drawRectangle({ x: 0, y: 0, width: 842, height: 595 });
    const mixed = await doc.save();

    const keep = await scalesOf(await imposeBookletPdf(mixed, LETTER, "left", { fit: "keep" }));
    const fill = await scalesOf(await imposeBookletPdf(mixed, LETTER, "left", { fit: "fill" }));
    // draw order of the 4 slots: sheet 0 front = [page 4 (scan), page 1], back = [page 2, page 3]
    const [scanFill, p1Fill, p2Fill, p3Fill] = fill as [number, number, number, number];
    const scanFits = Math.min(CELL_W / 842, CELL_H / 595);
    expect(scanFill).toBeCloseTo(scanFits, 9); // as big as the cell allows, whole page, nothing cut
    expect(p2Fill).toBeCloseTo(p1Fill, 9); // normal pages keep one text size
    expect(p3Fill).toBeCloseTo(p1Fill, 9);
    expect(p1Fill).toBeGreaterThan(keep[1]! * 1.15); // and they were still enlarged by the crop
    for (const [i, s] of fill.entries()) expect(s).toBeGreaterThanOrEqual(keep[i]! - 1e-9); // no page ever gets smaller
  });
});
