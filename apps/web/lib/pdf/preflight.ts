import "server-only";
import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { activeContentRejectionMessage, findActiveContent } from "./active-content";

/**
 * Server-side PDF preflight (docs/architecture.md sec 5). Never trust a
 * client-supplied page count - this is the only source of truth for
 * `print_jobs.source_pdf_pages`.
 */
export type PreflightResult =
  | { ok: true; pageCount: number; fileSizeBytes: number }
  | { ok: false; reason: string };

export async function preflightPdf(bytes: Uint8Array, opts: { maxSizeBytes: number }): Promise<PreflightResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "The uploaded file is empty." };
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
    return { ok: false, reason: "File does not look like a PDF (missing %PDF- header)." };
  }

  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pageCount = doc.getPageCount();
    if (pageCount === 0) {
      return { ok: false, reason: "PDF has no pages." };
    }

    // Structural validity is not the same as harmlessness: a perfectly valid
    // PDF can still declare embedded JavaScript, a /Launch action, or a file
    // attachment. None of those has any role in a document destined for
    // paper, and they are the realistic residual risk in this pipeline
    // (docs/architecture.md sec 5.1), so a job declaring one is rejected here
    // - before the bytes are ever persisted to Storage or handed to an Agent.
    const activeContent = findActiveContent(doc);
    if (activeContent.length > 0) {
      return { ok: false, reason: activeContentRejectionMessage(activeContent) };
    }

    return { ok: true, pageCount, fileSizeBytes: bytes.byteLength };
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      return { ok: false, reason: "PDF is password-protected/encrypted and cannot be processed. Remove the password and re-upload." };
    }
    return { ok: false, reason: "PDF is malformed or could not be parsed." };
  }
}
