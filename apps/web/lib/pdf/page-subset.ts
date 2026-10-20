import "server-only";
import { PDFDocument } from "pdf-lib";

/**
 * Produces a NEW PDF holding only the chosen pages (1-based, in the order
 * given - parsePageRange already de-duplicates and orders them). The original
 * upload is never touched: the caller stores this result as the job's derived
 * file, and everything downstream (booklet padding, imposition, print math,
 * quota) works on the subset. See docs/superpowers/specs/2026-10-20-printio-setup-design.md.
 *
 * Throws on an empty or out-of-range selection rather than quietly printing
 * the wrong pages; the caller validates with parsePageRange first, so a throw
 * here means a bug or a document pdf-lib cannot copy, and is reported as such.
 */
export async function createPageSubsetPdf(bytes: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("page subset needs at least one page");
  const source = await PDFDocument.load(bytes);
  const total = source.getPageCount();
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 1 || p > total) {
      throw new Error(`page ${p} is outside the document (1-${total})`);
    }
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pages.map((p) => p - 1),
  );
  for (const page of copied) out.addPage(page);
  return out.save();
}
