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

/** Most pages Printio will turn into a picture copy (lib/pdf/type3-rasterize.ts). Longer files are refused with the message below. */
export const PICTURE_COPY_MAX_PAGES = 30;

/** Shown when a picked file will be printed as a picture copy (nothing for the member to do). */
export const TYPE3_PICTURE_NOTICE =
  "This PDF's fonts can crash the office printer, so Printio will print a picture copy of it instead. It will look the same on paper; the text may be a little softer.";

/**
 * Plain words for the member whose file was held or refused. The second sentence is written to be copied to whatever
 * made the PDF (often an AI tool or a web page saved as PDF): it names the exact problem.
 */
export const TYPE3_HELD_MESSAGE =
  "Printio did not print this PDF because it can crash the office printer. Its text is stored as \"Type 3\" fonts with broken font boxes, which happens when a PDF is made from a web page (for example Chrome's Save as PDF, or an AI tool that builds a web page). " +
  "If an AI made this file, copy this to it: \"Please re-make this PDF so every font is a normal embedded TrueType or OpenType font, not Type 3 and not a variable font. Use a static font such as Arial, Liberation Sans or Times New Roman, keep the page size US Letter, and keep the text as real text.\" " +
  "Or open it in Word or Google Docs and download it as a PDF.";
