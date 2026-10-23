import "server-only";
import { createBookletPaddedPdf } from "./booklet";
import { imposeBookletPdf, resolvePaperSizePoints, type BindingSide, type BookletFit } from "./imposition";

/**
 * Pads a document to a multiple of 4 pages and imposes it as a saddle-stitch booklet. The single place the print
 * job pipeline and the booklet preview both go through, so what the member previews is exactly what is printed.
 */
export async function padAndImposeBooklet(
  workingBytes: Uint8Array,
  opts: { paperSize: string; bindingSide: BindingSide; fit: BookletFit },
): Promise<{ bytes: Uint8Array; paddedPages: number; blankPagesAdded: number }> {
  const padded = await createBookletPaddedPdf(workingBytes);
  const bytes = await imposeBookletPdf(padded.bytes, resolvePaperSizePoints(opts.paperSize), opts.bindingSide, { fit: opts.fit });
  return { bytes, paddedPages: padded.paddedPages, blankPagesAdded: padded.blankPagesAdded };
}
