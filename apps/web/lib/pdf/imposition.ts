import "server-only";
import { PDFDocument, type PDFPage } from "pdf-lib";

/**
 * Real N-up saddle-stitch booklet imposition (docs/architecture.md sec 8).
 *
 * Contrast with the Windows print driver's own "booklet" mode: a driver
 * picks ONE scale factor for the entire document (sized so the single
 * worst-case page - e.g. one oversized image or wide table - fits without
 * clipping), so every other, normally-sized page ends up shrunk down to that
 * worst-case scale and surrounded by needlessly huge margins. This module
 * instead computes each source page's scale *independently*, exactly like
 * Adobe Acrobat's booklet printing: a normal page fills as much of its own
 * half-sheet slot as it can, and only the one problem page shrinks further.
 * That per-page independence is the entire point of this module - see the
 * "different scale factors on different slots" assertion in
 * imposition.test.ts, which is the test that actually proves it.
 */

/**
 * Clearance kept on every outer edge of the sheet (about 0.2in = 14.4pt, written as 14pt). Stays above the
 * Kyocera's ~4mm (11.3pt) unprintable edge so nothing is clipped.
 */
export const IMPOSITION_MARGIN_PT = 14;

/**
 * Total clear space reserved at the center fold, split evenly between the
 * left and right slots (so each slot's inner edge sits 7.2pt = 0.1in off the fold).
 */
export const IMPOSITION_GUTTER_PT = 14.4;

/**
 * A source page smaller than its half-sheet cell is enlarged to fill it (like Acrobat's booklet printing), but
 * never past this factor: beyond 2x, raster content gets visibly soft and a tiny page would look absurd.
 */
export const IMPOSITION_MAX_UPSCALE = 2;

export interface SheetSizePt {
  width: number;
  height: number;
}

export interface SaddleStitchSheet {
  /** [leftSlotPageNumber, rightSlotPageNumber], 1-indexed source page numbers. */
  front: [number, number];
  back: [number, number];
}

/**
 * Standard saddle-stitch signature page order.
 *
 * For a padded document of `totalPages` pages (always a multiple of 4 - the
 * output of `createBookletPaddedPdf`), sheet `s` (0-indexed, s = 0..S-1,
 * S = totalPages/4) carries:
 *   front: left = totalPages - 2s,   right = 2s + 1
 *   back:  left = 2s + 2,            right = totalPages - 2s - 1
 * Sheet 0 is the outermost sheet (contains page 1 and the last page); sheet
 * S-1 is the innermost, nested sheet.
 *
 * Worked example (N=8, S=2) - verified by hand against physical folding
 * before trusting this formula (see imposition.test.ts and the PR/task
 * writeup for the full trace):
 *   sheet 0: front=[8,1] back=[2,7]
 *   sheet 1: front=[6,3] back=[4,5]
 * Reading the folded, nested, stapled booklet in physical order (front of
 * sheet0-right, then back of sheet0-left, then front of sheet1-right, ...)
 * produces 1,2,3,4,5,6,7,8 in sequence, as it must.
 *
 * `totalPages` must be a positive multiple of 4 (guaranteed by
 * `createBookletPaddedPdf` upstream) - this function throws rather than
 * silently null-padding a malformed input, matching the rest of this
 * codebase's convention for pure math helpers (e.g. `computeBookletPadding`).
 */
export function bookletPageOrder(totalPages: number): SaddleStitchSheet[] {
  if (!Number.isInteger(totalPages) || totalPages <= 0 || totalPages % 4 !== 0) {
    throw new Error(`totalPages must be a positive multiple of 4, got ${totalPages}`);
  }

  const sheetCount = totalPages / 4;
  const sheets: SaddleStitchSheet[] = [];
  for (let s = 0; s < sheetCount; s++) {
    sheets.push({
      front: [totalPages - 2 * s, 2 * s + 1],
      back: [2 * s + 2, totalPages - 2 * s - 1],
    });
  }
  return sheets;
}

interface SlotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SlotTransform {
  x: number;
  y: number;
  scale: number;
}

/**
 * The scale that makes a page of `pageWidth`x`pageHeight` fill `region` as much as it can: uniform (aspect ratio
 * kept), touching the limiting edge of the cell, centered. A page bigger than the cell shrinks to fit; a smaller
 * one is enlarged up to IMPOSITION_MAX_UPSCALE. Only scale and translation are decided here - which page goes in
 * which cell, the mirroring for right binding and the fold are all decided by the callers.
 */
function computeSlotTransform(pageWidth: number, pageHeight: number, region: SlotRegion): SlotTransform {
  const fitScale = Math.min(region.width / pageWidth, region.height / pageHeight);
  const scale = Math.min(fitScale, IMPOSITION_MAX_UPSCALE);
  const scaledWidth = pageWidth * scale;
  const scaledHeight = pageHeight * scale;
  return {
    x: region.x + (region.width - scaledWidth) / 2,
    y: region.y + (region.height - scaledHeight) / 2,
    scale,
  };
}

function slotRegions(outputWidth: number, outputHeight: number): { left: SlotRegion; right: SlotRegion } {
  const halfGutter = IMPOSITION_GUTTER_PT / 2;
  const slotWidth = outputWidth / 2 - halfGutter - IMPOSITION_MARGIN_PT;
  const slotHeight = outputHeight - 2 * IMPOSITION_MARGIN_PT;

  return {
    left: { x: IMPOSITION_MARGIN_PT, y: IMPOSITION_MARGIN_PT, width: slotWidth, height: slotHeight },
    right: {
      x: outputWidth / 2 + halfGutter,
      y: IMPOSITION_MARGIN_PT,
      width: slotWidth,
      height: slotHeight,
    },
  };
}

/**
 * Which physical edge a booklet job binds on - matching the Kyocera KX
 * driver's own booklet Layout-tab terminology for this printer family
 * ("Left edge binding" for LTR text, "Right edge binding" - explicitly
 * documented as intended for RTL text - see docs/printer-setup.md).
 *
 * `"left"` (the default) is today's existing, unchanged behavior: sheet
 * slot assignment straight from `bookletPageOrder`. `"right"` mirrors which
 * physical half-sheet slot each page lands in, sheet by sheet, so that
 * folding the sheet and reading right-to-left (e.g. Hebrew) produces the
 * pages in the correct order.
 *
 * Why mirroring left/right slot assignment (rather than, say, reversing the
 * page sequence) is the correct transform: the saddle-stitch fold-and-staple
 * hardware is left/right-symmetric - it always folds down the same vertical
 * centerline regardless of what content is on either side, so "which page
 * number ends up in which slot" is the only thing under this module's
 * control. Swapping every sheet's left/right slot contents produces the
 * exact mirror image of the `"left"` imposition; reading a mirrored physical
 * object in the mirrored (right-to-left) direction recovers the ORIGINAL
 * page sequence, not the reverse of it - see `imposition.test.ts`'s
 * `bindingSide: "right"` proof, which decodes the actual output PDF and
 * walks the physical RTL reading path term-by-term to confirm pages 1..N
 * really do appear in order for a right-to-left reader.
 */
export type BindingSide = "left" | "right";

/**
 * Imposes a padded booklet PDF (page count a multiple of 4, as produced by
 * `createBookletPaddedPdf`) into N/2 landscape output pages, two source
 * pages per side, in standard saddle-stitch signature order, each source
 * page scaled independently to fill as much of its own half-sheet slot as
 * it can (see module doc for the contrast with driver-side uniform scaling).
 *
 * Output page k (0-indexed) is physical sheet `Math.floor(k/2)`, front if k
 * is even, back if k is odd - matching how duplex printing already works
 * elsewhere in this system (consecutive PDF pages alternate front/back of
 * one physical sheet via the driver's own duplex unit).
 *
 * `sheetSize` is the target *portrait* sheet size in points (e.g. Letter =
 * 612x792) - read from the printer profile / job's own `paperSize`, never
 * hardcoded. The output page itself is the sheet in LANDSCAPE orientation
 * (width/height swapped), since two portrait half-pages sit side by side.
 *
 * `bindingSide` defaults to `"left"` (today's existing, unchanged behavior)
 * - see the `BindingSide` doc comment above for what `"right"` does and why
 * it's correct for RTL reading.
 */
export async function imposeBookletPdf(
  paddedBytes: Uint8Array,
  sheetSize: SheetSizePt,
  bindingSide: BindingSide = "left",
): Promise<Uint8Array> {
  const sourceDoc = await PDFDocument.load(paddedBytes);
  const totalPages = sourceDoc.getPageCount();
  const sheets = bookletPageOrder(totalPages);

  const outputWidth = sheetSize.height;
  const outputHeight = sheetSize.width;
  const { left: leftRegion, right: rightRegion } = slotRegions(outputWidth, outputHeight);

  // A page with no drawing operations on it at all (in particular, the
  // blank padding pages `createBookletPaddedPdf` appends) has no `Contents`
  // stream, which pdf-lib's page embedder refuses to embed ("Can't embed
  // page with missing Contents"). Force every source page to have a
  // (possibly empty) content stream before embedding - a genuinely blank
  // page just imposes as a blank half-sheet slot, per this module's doc.
  for (const sourcePage of sourceDoc.getPages()) {
    sourcePage.pushOperators();
  }

  const outDoc = await PDFDocument.create();
  const embeddedPages = await outDoc.embedPages(sourceDoc.getPages());

  function drawSlot(outPage: PDFPage, pageNumber: number, region: SlotRegion): void {
    const sourcePage = sourceDoc.getPage(pageNumber - 1);
    const { width, height } = sourcePage.getSize();
    const embedded = embeddedPages.at(pageNumber - 1);
    if (!embedded) {
      throw new Error(`imposeBookletPdf: no embedded page for source page number ${pageNumber}`);
    }
    const { x, y, scale } = computeSlotTransform(width, height, region);
    outPage.drawPage(embedded, { x, y, xScale: scale, yScale: scale });
  }

  // For "right edge binding", swap which physical slot each pair's two page
  // numbers land in - the mirroring described in the `BindingSide` doc
  // comment above. `bookletPageOrder`'s own sheet order/nesting is untouched
  // either way; only the left/right slot assignment within each sheet flips.
  function mirroredIfNeeded(pair: [number, number]): [number, number] {
    return bindingSide === "right" ? [pair[1], pair[0]] : pair;
  }

  for (const sheet of sheets) {
    const [frontLeft, frontRight] = mirroredIfNeeded(sheet.front);
    const frontPage = outDoc.addPage([outputWidth, outputHeight]);
    drawSlot(frontPage, frontLeft, leftRegion);
    drawSlot(frontPage, frontRight, rightRegion);

    const [backLeft, backRight] = mirroredIfNeeded(sheet.back);
    const backPage = outDoc.addPage([outputWidth, outputHeight]);
    drawSlot(backPage, backLeft, leftRegion);
    drawSlot(backPage, backRight, rightRegion);
  }

  return outDoc.save();
}

const LETTER_SIZE_PT: SheetSizePt = { width: 612, height: 792 };

const KNOWN_PAPER_SIZES_PT: Record<string, SheetSizePt> = {
  letter: LETTER_SIZE_PT,
  legal: { width: 612, height: 1008 },
  tabloid: { width: 792, height: 1224 },
  ledger: { width: 1224, height: 792 },
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
};

/**
 * Resolves a job/printer-profile `paperSize` string (e.g. "letter", "a4", or
 * a literal "11x17"/"8.5x11" inches-by-inches size, matching the free-form
 * values admins type into `printer_profiles.declared_paper_sizes` - see
 * PrintersPanel.tsx) into a portrait width/height in points.
 *
 * Falls back to Letter for an unrecognized string rather than throwing -
 * `paperSize` is admin-declared configuration (already used as-is in the
 * allow-listed `paper=` SumatraPDF token, docs/architecture.md sec 10), not
 * something imposition should be able to hard-fail a job over.
 */
export function resolvePaperSizePoints(paperSize: string): SheetSizePt {
  const key = paperSize.trim().toLowerCase();
  const known = KNOWN_PAPER_SIZES_PT[key];
  if (known) return known;

  const literalInches = key.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (literalInches) {
    const widthIn = Number(literalInches[1]);
    const heightIn = Number(literalInches[2]);
    return { width: widthIn * 72, height: heightIn * 72 };
  }

  return LETTER_SIZE_PT;
}
