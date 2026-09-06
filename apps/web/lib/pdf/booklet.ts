import "server-only";
import { PDFDocument } from "pdf-lib";
import { computeBookletPadding } from "@printio/shared";

export interface BookletDerivedPdf {
  bytes: Uint8Array;
  blankPagesAdded: number;
  paddedPages: number;
}

/**
 * Produces a derived, booklet-padded copy of a PDF. NEVER mutates or
 * overwrites the original upload - the caller stores this result at a
 * separate `derived_file_path` (docs/architecture.md sec 8).
 */
export async function createBookletPaddedPdf(bytes: Uint8Array): Promise<BookletDerivedPdf> {
  const doc = await PDFDocument.load(bytes);
  const sourcePages = doc.getPageCount();
  const { paddedPages, blankPagesAdded } = computeBookletPadding(sourcePages);

  if (blankPagesAdded > 0) {
    const lastPage = doc.getPage(sourcePages - 1);
    const { width, height } = lastPage.getSize();
    for (let i = 0; i < blankPagesAdded; i++) {
      doc.addPage([width, height]);
    }
  }

  const outBytes = await doc.save();
  return { bytes: outBytes, blankPagesAdded, paddedPages };
}
