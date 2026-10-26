import "server-only";
import { checkPdfInflation } from "./inflate-guard";
import { PDFDocument } from "pdf-lib";
import { containsPjlEscape, PJL_ESCAPE_MESSAGE } from "@printio/shared";
import { findActiveContent } from "./active-content";
import { isEncryptedError, sanitizePdf } from "./sanitize";

/**
 * Server-side PDF preflight (docs/architecture.md sec 5). Never trust a
 * client-supplied page count - this is the only source of truth for
 * `print_jobs.source_pdf_pages`.
 */
export type PreflightResult =
  | {
      ok: true;
      pageCount: number;
      /** Size of the file as uploaded (what is stored as the original). */
      fileSizeBytes: number;
      /**
       * Present only when the upload carried attachments/JavaScript/launch actions: the same document with
       * those removed. Everything downstream (page range, imposition, stamp, the file that prints) must use
       * this instead of the uploaded bytes.
       */
      sanitizedBytes?: Uint8Array;
    }
  | { ok: false; reason: string };

/** Most pages a single upload may have unless the caller says otherwise (security review F9). */
export const DEFAULT_MAX_PDF_PAGES = 500;

export async function preflightPdf(bytes: Uint8Array, opts: { maxSizeBytes: number; maxPages?: number }): Promise<PreflightResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "That file is empty." };
  }
  if (bytes.byteLength > opts.maxSizeBytes) {
    const maxMb = (opts.maxSizeBytes / (1024 * 1024)).toFixed(0);
    return { ok: false, reason: `File exceeds this organization's ${maxMb} MB upload limit.` };
  }

  // Magic-byte check before attempting a full structural parse - fast reject
  // for obviously-wrong files (renamed .docx, images, etc.) regardless of
  // what MIME type the browser claimed.
  const header = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 5));
  if (header !== "%PDF-") {
    return { ok: false, reason: "This file doesn't look like a PDF. Choose a PDF file." };
  }

  // A PDF that carries the printer's escape sequence could run its own PJL commands when streamed to the
  // printer's raw port (security review F1). There is no legitimate reason for one to be in a document.
  if (containsPjlEscape(bytes)) return { ok: false, reason: PJL_ESCAPE_MESSAGE };

  // A file that is tiny but expands enormously when opened would crash the server: refuse it before it is opened.
  const inflation = checkPdfInflation(bytes);
  if (!inflation.ok) return { ok: false, reason: inflation.reason };

  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pageCount = doc.getPageCount();
    if (pageCount === 0) {
      return { ok: false, reason: "This PDF has no pages." };
    }
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PDF_PAGES;
    if (pageCount > maxPages) {
      return {
        ok: false,
        reason: `This PDF has ${pageCount} pages, which is more than the ${maxPages}-page limit. Split it into smaller files and upload them separately.`,
      };
    }

    // Structural validity is not the same as harmlessness: a perfectly valid PDF can still carry embedded
    // files (Android's print service adds one), JavaScript or a /Launch action. None has any role on paper, so
    // rather than refusing a document its sender cannot fix, strip them (lib/pdf/sanitize.ts) and let the rest
    // of the pipeline work on the clean copy. If stripping fails, fall back to refusing.
    if (findActiveContent(doc).length > 0) {
      const clean = await sanitizePdf(bytes);
      if (!clean.ok) {
        return { ok: false, reason: "This PDF has extra content Printio can't remove. Open it, choose Print, then Save as PDF, and upload that copy." };
      }
      // The sanitizer re-saves the file; make sure what comes out is clean too, since that copy is what prints.
      if (containsPjlEscape(clean.bytes)) return { ok: false, reason: PJL_ESCAPE_MESSAGE };
      return { ok: true, pageCount, fileSizeBytes: bytes.byteLength, sanitizedBytes: clean.bytes };
    }

    return { ok: true, pageCount, fileSizeBytes: bytes.byteLength };
  } catch (err) {
    if (isEncryptedError(err)) {
      return { ok: false, reason: "This PDF is password-protected. Remove the password, or print it to a new PDF, and try again." };
    }
    return { ok: false, reason: "We couldn't read this PDF. Open it, choose Print, then Save as PDF, and upload that copy." };
  }
}
