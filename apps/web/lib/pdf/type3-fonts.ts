import { PDFDict, PDFName, type PDFDocument } from "pdf-lib";

/**
 * Type 3 fonts store every letter as a tiny drawing program. Chrome's "Save as PDF" and several HTML-to-PDF
 * tools emit them for web fonts. The Kyocera's built-in PDF reader (the path Printio sends files down) has been
 * seen to stop with "System error. Turn the main power switch off and on." right after receiving such a file
 * (2026-11-15, docs/kyocera-raw-print.md). Printing the same file from a PC works because the Windows driver
 * draws the page first. Until a conversion exists, Printio holds these files instead of risking the printer.
 */
export function hasType3Fonts(doc: PDFDocument): boolean {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const subtype = obj.get(PDFName.of("Subtype"));
    if (subtype === PDFName.of("Type3") && obj.get(PDFName.of("CharProcs"))) return true;
  }
  return false;
}

/** Plain words for the member whose file was held. */
export const TYPE3_HELD_MESSAGE =
  "This PDF stores its text in a way the office printer can crash on, so nothing was printed. " +
  "Ask your administrator to print it, or re-create the PDF with a different tool (for example Microsoft Word or Google Docs, then Download as PDF).";
