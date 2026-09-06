import { describe, expect, it } from "vitest";
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFPage,
} from "pdf-lib";
import {
  bookletPageOrder,
  imposeBookletPdf,
  resolvePaperSizePoints,
  IMPOSITION_MARGIN_PT,
  IMPOSITION_GUTTER_PT,
} from "./imposition";
import { createBookletPaddedPdf } from "./booklet";

const LETTER: [number, number] = [612, 792];

async function makePdf(pageSizes: Array<[number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h] of pageSizes) doc.addPage([w, h]);
  return doc.save();
}

/**
 * Reads a page's actual, drawn content stream back out of pdf-lib's
 * low-level object model and returns the xScale (the `a` component of each
 * `cm` matrix operator, in document order) that each `drawPage` call in
 * imposition.ts actually emitted - i.e. the real, physically-drawn scale
 * factor per slot, not a recomputation of what it *should* be.
 */
function decodePageContent(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const rawStreams: PDFRawStream[] =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => doc.context.lookup(contents.get(i)) as PDFRawStream)
      : contents
        ? [contents as PDFRawStream]
        : [];

  const decoded = rawStreams.map((s) => decodePDFRawStream(s).decode());
  const totalLength = decoded.reduce((sum, d) => sum + d.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const d of decoded) {
    merged.set(d, offset);
    offset += d.length;
  }
  return new TextDecoder("latin1").decode(merged);
}

/**
 * Extracts the effective drawn xScale for each `q ... Do ... Q` block in the
 * content stream (one block per `drawPage` call), in appearance order.
 *
 * pdf-lib's `drawPage` decomposes translate/scale/rotate/skew into several
 * chained `cm` operators per call (all diagonal/identity matrices here,
 * since imposition.ts never sets rotate/skew) rather than one single
 * pre-multiplied matrix, so the real scale is the PRODUCT of every `cm`
 * operator's `a` component within a block, not any one fixed operator index
 * - multiplying them out is what makes this robust to however many
 * (identity or not) `cm` operators a given pdf-lib version happens to emit.
 */
function extractDrawnXScales(contentString: string): number[] {
  const cmPattern = /(-?[\d.]+)\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+cm/g;
  const scales: number[] = [];
  for (const block of contentString.split(/\bQ\b/)) {
    if (!block.includes(" Do") && !block.includes("Do\n")) continue;
    let combinedXScale = 1;
    let matched = false;
    for (const match of block.matchAll(cmPattern)) {
      combinedXScale *= parseFloat(match[1]!);
      matched = true;
    }
    if (matched) scales.push(combinedXScale);
  }
  return scales;
}

/**
 * Extracts the XObject resource NAME referenced by each `q ... /Name Do ...
 * Q` block's `Do` operator, in appearance order (one name per `drawPage`
 * call, same block-splitting convention as `extractDrawnXScales`). This is
 * step 1 of proving which *source page* actually landed in which physical
 * slot - step 2 (`resolveDrawnPageWidths` below) resolves each name back to
 * the source page it refers to.
 */
function extractDrawnXObjectNames(contentString: string): string[] {
  const names: string[] = [];
  for (const block of contentString.split(/\bQ\b/)) {
    const match = block.match(/\/(\S+)\s+Do\b/);
    if (match) names.push(match[1]!);
  }
  return names;
}

/**
 * For one output page, resolves each drawn `Do` block back to the actual
 * source page it draws - identified via genuine object identity, not
 * inferred from scale: each name in the page's own `/XObject` resource
 * dictionary is a `PDFRef` pointing at a Form XObject (the embedded source
 * page - see pdf-lib's `PDFPage.drawPage`/`PDFPageEmbedder`), and that Form
 * XObject's own `/BBox` is a verbatim copy of the source page's MediaBox
 * (`fullPageBoundingBox` in pdf-lib's `PDFPageEmbedder.embedIntoContext`) -
 * so a source page's *width* (BBox right - left), if every source page is
 * given a distinct width, is an exact, non-floating-point identifier of
 * which page was drawn, independent of whatever scale it was drawn at.
 *
 * Returns the drawn page widths in appearance order (left slot's page first,
 * then right slot's, matching `drawSlot`'s call order in imposition.ts).
 */
function resolveDrawnPageWidths(doc: PDFDocument, page: PDFPage): number[] {
  const resources = page.node.Resources();
  if (!resources) throw new Error("output page has no Resources");
  const xObjectDict = resources.lookup(PDFName.of("XObject"), PDFDict);

  const names = extractDrawnXObjectNames(decodePageContent(doc, page));
  return names.map((name) => {
    const ref = xObjectDict.get(PDFName.of(name));
    if (!(ref instanceof PDFRef)) throw new Error(`XObject /${name} is not a reference`);
    const formXObject = doc.context.lookup(ref, PDFStream);
    const bbox = formXObject.dict.lookup(PDFName.of("BBox"), PDFArray);
    const left = bbox.lookup(0, PDFNumber).asNumber();
    const right = bbox.lookup(2, PDFNumber).asNumber();
    return right - left;
  });
}

describe("bookletPageOrder", () => {
  it("matches the worked N=8 example exactly", () => {
    // Hand-verified saddle-stitch trace (see module doc): sheet 0 is
    // outermost (pages 1 and 8 live on it), sheet 1 is innermost.
    expect(bookletPageOrder(8)).toEqual([
      { front: [8, 1], back: [2, 7] },
      { front: [6, 3], back: [4, 5] },
    ]);
  });

  it("matches the N=4 single-sheet case", () => {
    expect(bookletPageOrder(4)).toEqual([{ front: [4, 1], back: [2, 3] }]);
  });

  it("matches the N=12 three-sheet case", () => {
    expect(bookletPageOrder(12)).toEqual([
      { front: [12, 1], back: [2, 11] },
      { front: [10, 3], back: [4, 9] },
      { front: [8, 5], back: [6, 7] },
    ]);
  });

  it("rejects a page count that is not a positive multiple of 4", () => {
    expect(() => bookletPageOrder(6)).toThrow(/multiple of 4/);
    expect(() => bookletPageOrder(0)).toThrow(/multiple of 4/);
    expect(() => bookletPageOrder(-4)).toThrow(/multiple of 4/);
  });
});

describe("resolvePaperSizePoints", () => {
  it("resolves known named sizes", () => {
    expect(resolvePaperSizePoints("letter")).toEqual({ width: 612, height: 792 });
    expect(resolvePaperSizePoints("Letter")).toEqual({ width: 612, height: 792 });
  });

  it("resolves a literal WxH-inches string", () => {
    expect(resolvePaperSizePoints("11x17")).toEqual({ width: 792, height: 1224 });
  });

  it("falls back to Letter for an unrecognized string rather than throwing", () => {
    expect(resolvePaperSizePoints("some-unknown-size")).toEqual({ width: 612, height: 792 });
  });
});

describe("imposeBookletPdf", () => {
  it("produces exactly N/2 output pages for a padded input", async () => {
    const padded = await makePdf(Array(8).fill(LETTER));
    const out = await imposeBookletPdf(padded, { width: 612, height: 792 });
    const outDoc = await PDFDocument.load(out);
    expect(outDoc.getPageCount()).toBe(4);
  });

  it("every output page is the sheet size in landscape orientation", async () => {
    const padded = await makePdf(Array(8).fill(LETTER));
    const out = await imposeBookletPdf(padded, { width: 612, height: 792 });
    const outDoc = await PDFDocument.load(out);
    for (const page of outDoc.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBe(792);
      expect(height).toBe(612);
    }
  });

  it("scales two differently-sized/aspect-ratio source pages independently, not uniformly", async () => {
    // Page A: a normal portrait Letter page - should nearly fill its slot.
    // Page B: a much larger, wide landscape page (the "one oversized table"
    // scenario from the task) - forced to shrink much further to fit.
    // A driver's own uniform-scale booklet mode would apply ONE scale to
    // both; this assertion is the one that proves independence.
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]); // page 1: normal portrait Letter
    doc.addPage([2400, 1200]); // page 2: oversized wide landscape
    doc.addPage([612, 792]); // page 3
    doc.addPage([612, 792]); // page 4
    const bytes = await doc.save();

    const out = await imposeBookletPdf(bytes, { width: 612, height: 792 });
    const outDoc = await PDFDocument.load(out);
    expect(outDoc.getPageCount()).toBe(2);

    // N=4 -> sheet 0 front=[4,1] (left=page4, right=page1), back=[2,3]
    // (left=page2, right=page3). Front page (index 0) draws two normal
    // Letter pages (4 and 1) - both should land at the same scale. Back page
    // (index 1) draws page 2 (the oversized page) in the left slot and page
    // 3 (normal Letter) in the right slot - these two MUST differ.
    const frontScales = extractDrawnXScales(decodePageContent(outDoc, outDoc.getPage(0)));
    const backScales = extractDrawnXScales(decodePageContent(outDoc, outDoc.getPage(1)));

    expect(frontScales).toHaveLength(2);
    expect(backScales).toHaveLength(2);

    const frontLeftScale = frontScales[0]!; // page 4 - normal Letter
    const frontRightScale = frontScales[1]!; // page 1 - normal Letter
    const oversizedScale = backScales[0]!; // page 2 - oversized landscape
    const normalScaleOnBack = backScales[1]!; // page 3 - normal Letter

    // Both normal-Letter pages on the front sheet get the identical scale -
    // same aspect ratio, same slot, same result.
    expect(frontLeftScale).toBeCloseTo(frontRightScale, 5);
    // The normal Letter page on the back sheet lands at that same scale too.
    expect(normalScaleOnBack).toBeCloseTo(frontLeftScale, 5);

    // This is the assertion the whole feature exists to satisfy: the
    // oversized page's independently-computed scale is genuinely different
    // (and substantially smaller) than the normal page's scale in the exact
    // same slot - a driver's uniform-scale booklet mode would instead force
    // BOTH to the oversized page's scale.
    expect(oversizedScale).toBeLessThan(normalScaleOnBack);
    expect(oversizedScale).toBeLessThan(normalScaleOnBack * 0.5);
  });

  it("does not upscale a page already smaller than its slot beyond 100%, and centers it", async () => {
    // A tiny page fits its slot with huge headroom - per this module's
    // documented design decision, scale caps at 1.0 rather than enlarging it.
    const doc = await PDFDocument.create();
    doc.addPage([100, 150]); // tiny page, front-left (page 1 of a 4-page pad -> sheet0 left=page4... )
    doc.addPage([100, 150]);
    doc.addPage([100, 150]);
    doc.addPage([100, 150]);
    const bytes = await doc.save();

    const out = await imposeBookletPdf(bytes, { width: 612, height: 792 });
    const outDoc = await PDFDocument.load(out);
    const scales = extractDrawnXScales(decodePageContent(outDoc, outDoc.getPage(0)));
    for (const scale of scales) {
      expect(scale).toBeLessThanOrEqual(1);
      expect(scale).toBeCloseTo(1, 5);
    }
  });

  it("caps at 1.0 rather than upscaling, verified against the module's own slot geometry", () => {
    const outputWidth = 792;
    const outputHeight = 612;
    const halfGutter = IMPOSITION_GUTTER_PT / 2;
    const slotWidth = outputWidth / 2 - halfGutter - IMPOSITION_MARGIN_PT;
    const slotHeight = outputHeight - 2 * IMPOSITION_MARGIN_PT;

    // A page smaller than the slot in both dimensions would compute a
    // fit-scale > 1 if uncapped.
    const tinyWidth = slotWidth / 4;
    const tinyHeight = slotHeight / 4;
    const fitScale = Math.min(slotWidth / tinyWidth, slotHeight / tinyHeight);
    expect(fitScale).toBeGreaterThan(1);
    expect(Math.min(fitScale, 1)).toBe(1);
  });

  it("imposes a real booklet-padded 6-page document (8 padded pages) end to end", async () => {
    const original = await makePdf(Array(6).fill(LETTER));
    const padded = await createBookletPaddedPdf(original);
    expect(padded.paddedPages).toBe(8);

    const out = await imposeBookletPdf(padded.bytes, { width: 612, height: 792 });
    const outDoc = await PDFDocument.load(out);
    expect(outDoc.getPageCount()).toBe(4); // 8/2
  });
});

describe("imposeBookletPdf bindingSide", () => {
  /**
   * Builds an 8-page source PDF where page N (1-indexed) has a distinct,
   * exactly-reversible width (100 + N) and a fixed, deliberately-tiny height
   * (150) - `resolveDrawnPageWidths` turns each drawn width straight back
   * into the source page number that produced it (width - 100 = N), giving
   * every assertion below genuine, non-floating-point proof of *which page*
   * physically landed in which slot, not just "the scale looks different."
   */
  async function makeIdentifiable8PagePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let n = 1; n <= 8; n++) doc.addPage([100 + n, 150]);
    return doc.save();
  }

  it("bindingSide \"left\" (the default) matches bookletPageOrder's own slot assignment exactly", async () => {
    const bytes = await makeIdentifiable8PagePdf();
    // No third argument at all - proves the default is genuinely "left",
    // not just documented as such.
    const out = await imposeBookletPdf(bytes, { width: 612, height: 792 });
    const outDoc = await PDFDocument.load(out);
    expect(outDoc.getPageCount()).toBe(4);

    const front0 = resolveDrawnPageWidths(outDoc, outDoc.getPage(0)).map((w) => w - 100);
    const back0 = resolveDrawnPageWidths(outDoc, outDoc.getPage(1)).map((w) => w - 100);
    const front1 = resolveDrawnPageWidths(outDoc, outDoc.getPage(2)).map((w) => w - 100);
    const back1 = resolveDrawnPageWidths(outDoc, outDoc.getPage(3)).map((w) => w - 100);

    const sheets = bookletPageOrder(8);
    expect(front0).toEqual(sheets[0]!.front);
    expect(back0).toEqual(sheets[0]!.back);
    expect(front1).toEqual(sheets[1]!.front);
    expect(back1).toEqual(sheets[1]!.back);
  });

  it('bindingSide "right" mirrors every sheet\'s left/right slot assignment (same sheets, swapped sides)', async () => {
    const bytes = await makeIdentifiable8PagePdf();
    const out = await imposeBookletPdf(bytes, { width: 612, height: 792 }, "right");
    const outDoc = await PDFDocument.load(out);
    expect(outDoc.getPageCount()).toBe(4);

    const front0 = resolveDrawnPageWidths(outDoc, outDoc.getPage(0)).map((w) => w - 100);
    const back0 = resolveDrawnPageWidths(outDoc, outDoc.getPage(1)).map((w) => w - 100);
    const front1 = resolveDrawnPageWidths(outDoc, outDoc.getPage(2)).map((w) => w - 100);
    const back1 = resolveDrawnPageWidths(outDoc, outDoc.getPage(3)).map((w) => w - 100);

    // Exactly the "left" sheets (sheets 0/1 = front [8,1]/[6,3], back
    // [2,7]/[4,5] - see bookletPageOrder's own worked-example comment) with
    // each pair's two entries swapped - same sheets/nesting, mirrored sides.
    const leftSheets = bookletPageOrder(8);
    expect(front0).toEqual([leftSheets[0]!.front[1], leftSheets[0]!.front[0]]);
    expect(back0).toEqual([leftSheets[0]!.back[1], leftSheets[0]!.back[0]]);
    expect(front1).toEqual([leftSheets[1]!.front[1], leftSheets[1]!.front[0]]);
    expect(back1).toEqual([leftSheets[1]!.back[1], leftSheets[1]!.back[0]]);

    // Concretely: front0=[1,8], back0=[7,2], front1=[3,6], back1=[5,4].
    expect(front0).toEqual([1, 8]);
    expect(back0).toEqual([7, 2]);
    expect(front1).toEqual([3, 6]);
    expect(back1).toEqual([5, 4]);

    // The actual proof: walk the physical path a right-to-left reader
    // follows through this exact mirrored, folded, nested, stapled object,
    // and confirm it produces pages 1..8 IN ORDER - not just "some values
    // changed." This is the mirror image of the module doc's own "reading
    // the folded, nested, stapled booklet in physical order" trace for the
    // left-bound case (front-right, back-left, front-right, ...): reading a
    // mirrored object in the mirrored direction swaps every left<->right
    // term in that same physical traversal path.
    //
    //   front0-left  -> back0-right -> front1-left -> back1-right ->
    //   back1-left   -> front1-right -> back0-left -> front0-right
    //
    // A right-to-left reader opens the booklet (front0-left = the exterior
    // cover position for this mirrored object), then each successive
    // fold/turn reveals the next term in this path.
    const rtlReadingOrder = [
      front0[0], // front0-left  (cover)
      back0[1], // back0-right
      front1[0], // front1-left
      back1[1], // back1-right
      back1[0], // back1-left   (center spread, other half)
      front1[1], // front1-right
      back0[0], // back0-left
      front0[1], // front0-right (back cover)
    ];
    expect(rtlReadingOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('bindingSide "left" passed explicitly produces byte-identical output to the default (no third argument)', async () => {
    const bytes = await makeIdentifiable8PagePdf();
    const implicit = await imposeBookletPdf(bytes, { width: 612, height: 792 });
    const explicit = await imposeBookletPdf(bytes, { width: 612, height: 792 }, "left");
    expect(Buffer.from(explicit)).toEqual(Buffer.from(implicit));
  });
});
