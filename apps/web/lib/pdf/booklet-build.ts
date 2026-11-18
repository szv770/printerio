import "server-only";
import { createBookletPaddedPdf } from "./booklet";
import { imposeBookletPdf, resolvePaperSizePoints, type BindingSide, type BookletFit } from "./imposition";

/**
 * Which sheet a booklet is printed on.
 *  - "letter" (regular): the paper the job already uses; each page shrinks to a half-sheet (statement-size) cell.
 *  - "tabloid" (11x17): Letter pages stay about full size on an 11x17 sheet, saddle-stitched. The whole page is kept
 *    (never cropped or enlarged past its cell), so a Letter page comes out as a Letter page.
 * UNVERIFIED on the printer: the raw path sends no paper size, so the printer has to choose 11x17 from the page size.
 */
export type BookletSheet = "letter" | "tabloid";

export function bookletSheetChoice(value: unknown): BookletSheet {
  return value === "tabloid" ? "tabloid" : "letter";
}

/**
 * Pads a document to a multiple of 4 pages and imposes it as a saddle-stitch booklet. The single place the print
 * job pipeline and the booklet preview both go through, so what the member previews is exactly what is printed.
 */
export async function padAndImposeBooklet(
  workingBytes: Uint8Array,
  opts: { paperSize: string; bindingSide: BindingSide; fit: BookletFit; sheet?: BookletSheet },
): Promise<{ bytes: Uint8Array; paddedPages: number; blankPagesAdded: number }> {
  const tabloid = opts.sheet === "tabloid";
  const padded = await createBookletPaddedPdf(workingBytes);
  const bytes = await imposeBookletPdf(padded.bytes, resolvePaperSizePoints(tabloid ? "tabloid" : opts.paperSize), opts.bindingSide, {
    fit: tabloid ? "keep" : opts.fit,
  });
  return { bytes, paddedPages: padded.paddedPages, blankPagesAdded: padded.blankPagesAdded };
}
