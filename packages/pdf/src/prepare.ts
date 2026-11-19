import { computeBookletPadding, containsPjlEscape, PJL_ESCAPE_MESSAGE, planPageSubset } from "@printio/shared";
import { padAndImposeBooklet } from "./booklet-build";
import type { BookletSheet } from "./booklet-sheet";
import { detectImageKind, imageToPdf, type ImageFit } from "./image-to-pdf";
import { buildLayoutPdf, LayoutError, layoutSheetCount, layoutSheetGroups, validateLayout, type LayoutSpec } from "./nup";
import type { BookletFit } from "./imposition";
import { createPageSubsetPdf } from "./page-subset";
import { preflightPdf } from "./preflight";
import { stampFirstPage } from "./stamp";
import { checkTextFidelity, TEXT_CHANGED_MESSAGE } from "./text-fidelity";
import { TYPE3_HELD_MESSAGE } from "./type3-fonts";
import { rasterizePdf } from "./type3-rasterize";

/**
 * The PDF half of making a print job (docs/PREPARE-JOBS-DESIGN.md, P2): everything that has to open, rewrite or inspect the
 * uploaded file, and nothing that touches a database. It was cut out of `createPrintJob` (apps/web/lib/jobs/create-print-job.ts)
 * without changing a single decision, so the same code can run in the website today and on the organization's print server next.
 *
 * Order, exactly as before: (a JPEG/PNG upload is first turned into a one-page PDF) preflight (sanitize, page count, active content, Type 3 detection) -> Type 3 picture copy -> page range
 * -> page layout (n-up / repeat, only when asked, never with a booklet) or booklet padding and imposition (unless held) -> user-code stamp (unless held) -> text-fidelity safeguard -> last-line PJL guard.
 *
 * The CALLER decides, before any PDF work, whether the job is held (it needs the printer profile for that) and passes the reason in;
 * this function may add a hold of its own (Type 3 file that cannot be drawn, text that changed) and says so in the result.
 * No database, no Next.js, no environment: everything it needs comes in through `PreparePdfInput`.
 */

export type PreparePdfErrorCode = "bad_pdf" | "invalid_page_range" | "subset_failed" | "booklet_failed";

export interface PrepareLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface StampPlan {
  text: string;
  strength: "light" | "medium" | "strong";
}

export interface PreparePdfInput {
  originalBytes: Uint8Array;
  /** The organization's upload limit, handed to preflight. */
  maxUploadBytes: number;
  colorMode: "bw" | "color";
  /** Decided by the caller before any PDF work; non-null means the job is held and prints nothing yet. */
  heldReason: string | null;
  /** The caller forced a hold (the IPP gateway does): a range that does not fit then never fails, it is dropped and the job is held with both reasons. */
  forcedHeldReason?: string;
  /** The sender's page range text (trimmed), or null for the whole document. */
  pageRangeText: string | null;
  booklet: boolean;
  bookletOptions: { paperSize: string; bindingSide: "left" | "right"; fit: BookletFit; sheet: BookletSheet };
  confirmBookletPadding: boolean;
  /**
   * The code stamp for page 1 of the final file, `null` for none. A function is called ONLY when the pipeline reaches the stamp step with
   * a job that is not held (building it can cost a database write, which must not happen for a job that ends up held); if it throws, the
   * job goes through unstamped (losing a print is worse than losing a label).
   */
  stamp: StampPlan | (() => Promise<StampPlan | null>) | null;
  /** PRINTIO_ALLOW_TYPE3_FONTS=1: send Type 3 files as they are instead of as a picture copy. */
  allowType3Fonts: boolean;
  /**
   * Optional page layout (several pages per sheet, or one page repeated), applied after the page range in place of the booklet step.
   * Not allowed together with `booklet`. Absent = today's behaviour, byte for byte.
   */
  layout?: LayoutSpec;
  /** Optional: how a JPEG/PNG upload is placed on its page (paper defaults to the booklet options' paper size). */
  imageOptions?: { fit?: ImageFit; paperSize?: string; margin?: number };
  /** Extra fields for log lines (organization, profile, user ...). */
  logContext: Record<string, unknown>;
  logger: PrepareLogger;
}

export type PreparePdfResult =
  | {
      ok: true;
      held: boolean;
      heldReason: string | null;
      /** What the Agent prints (sanitized, subset, imposed and stamped as needed); null = print the stored original / held. */
      derivedBytes: Uint8Array | null;
      /** Pages that count for print math (padded to a multiple of 4 for a booklet; physical pages/sides of the output for a layout). */
      effectivePageCount: number;
      blankPagesAdded: number;
      /** Pages that will print after the page range. */
      sourcePages: number;
      /** The range text to store: the sender's, or null when it was dropped for a forced hold. */
      pageRangeText: string | null;
      fileSizeBytes: number;
      /** True when a Type 3 file was drawn into a picture copy. */
      pictureCopy: boolean;
    }
  | { ok: false; kind: "error"; code: PreparePdfErrorCode; error: string; fieldErrors?: { pageRange?: string } }
  | { ok: false; kind: "needs_booklet_confirm"; needsBookletConfirm: { sourcePages: number; paddedPages: number; blankPagesAdded: number } };

function error(code: PreparePdfErrorCode, message: string, fieldErrors?: { pageRange?: string }): PreparePdfResult {
  return { ok: false, kind: "error", code, error: message, ...(fieldErrors ? { fieldErrors } : {}) };
}

export async function preparePdf(input: PreparePdfInput): Promise<PreparePdfResult> {
  const { originalBytes, colorMode, booklet, logger, logContext } = input;
  const layout = input.layout;
  let heldReason = input.heldReason;
  let held = heldReason !== null;

  if (layout) {
    // Layout and booklet both decide how pages sit on the sheet; in this version only one may be asked for. A layout that makes no sense
    // is refused here as well (the page-dependent check of a chosen repeat page comes after the page range). Reported with the existing
    // "booklet_failed" code because the website only knows the codes of PreparePdfErrorCode.
    if (booklet) return error("booklet_failed", "Pages per sheet and Booklet can't be combined yet. Choose one of them.");
    const bad = validateLayout(layout);
    if (bad) return error("booklet_failed", bad);
  }

  // A JPEG or PNG is turned into a one-page PDF first and then goes through everything below like any other PDF (the page range then
  // sees one page). It always prints from that derived PDF, never from the stored picture.
  let imagePdf: Uint8Array | null = null;
  if (detectImageKind(originalBytes)) {
    const converted = await imageToPdf(originalBytes, {
      maxBytes: input.maxUploadBytes,
      paperSize: input.imageOptions?.paperSize ?? input.bookletOptions.paperSize,
      ...(input.imageOptions?.fit ? { fit: input.imageOptions.fit } : {}),
      ...(input.imageOptions?.margin !== undefined ? { margin: input.imageOptions.margin } : {}),
    });
    if (!converted.ok) return error("bad_pdf", converted.reason);
    imagePdf = converted.bytes;
  }
  // The PDF the rest of the pipeline reads as "the upload" (for a picture: its converted page; the size limit was already checked on the picture).
  const pdfInput = imagePdf ?? originalBytes;

  const preflight = await preflightPdf(pdfInput, { maxSizeBytes: imagePdf ? Math.max(input.maxUploadBytes, imagePdf.byteLength) : input.maxUploadBytes });
  if (!preflight.ok) return error("bad_pdf", preflight.reason);

  // Type 3 fonts have crashed the printer's PDF reader (2026-11-15). Printio draws such a file page by page into a picture copy
  // (type3-rasterize) and prints that instead; if it cannot (too many pages, too slow), the job is held with a plain message.
  let pictureCopy: Uint8Array | null = null;
  if (preflight.hasType3Fonts && !input.allowType3Fonts && !heldReason) {
    const drawn = await rasterizePdf(preflight.sanitizedBytes ?? pdfInput, { color: colorMode === "color" });
    if (drawn.ok) {
      pictureCopy = drawn.bytes;
      logger.warn("PDF has Type 3 fonts; printing a picture copy", { ...logContext, pages: drawn.pages });
    } else {
      logger.warn("PDF has Type 3 fonts and could not be converted; job held", { ...logContext, reason: drawn.reason });
      heldReason = TYPE3_HELD_MESSAGE;
      held = true;
    }
  }

  // Attachments, JavaScript and launch actions are stripped rather than refused (a teacher cannot fix them, and the Android print
  // service adds one). The upload is still stored untouched as the original; everything that prints is built from the sanitized copy,
  // so a sanitized job always gets a derived file (the Agent prints the derived file whenever there is one).
  const sanitized = pictureCopy ?? preflight.sanitizedBytes ?? imagePdf;
  const sourceBytes = sanitized ?? pdfInput;

  // The page range is applied FIRST, so booklet padding, imposition, print math, policy and quota all work on the pages that will
  // actually print. The original upload is stored untouched; the subset is derived. A held job never builds a subset (planPageSubset
  // only validates and counts its range); the sender's range text is stored and re-applied on release.
  let pageRangeText = input.pageRangeText;
  let plan = planPageSubset({ pageRangeText, pageCount: preflight.pageCount, held });
  if (!plan.ok && input.forcedHeldReason) {
    // A forced hold must never fail on a range that does not fit this document (the print dialog cannot show an inline error):
    // keep the job, hold it with both reasons, and drop the range so it can be re-chosen.
    heldReason = `${input.forcedHeldReason} ${plan.reason}`;
    pageRangeText = null;
    plan = planPageSubset({ pageRangeText, pageCount: preflight.pageCount, held });
  }
  if (!plan.ok) return error("invalid_page_range", plan.reason, { pageRange: plan.reason });
  const sourcePages = plan.sourcePages;
  if (layout) {
    const bad = validateLayout(layout, sourcePages);
    if (bad) return error("booklet_failed", bad);
  }
  let workingBytes = sourceBytes;
  let subsetBytes: Uint8Array | null = null;
  if (plan.subsetPages) {
    try {
      subsetBytes = await createPageSubsetPdf(sourceBytes, plan.subsetPages);
    } catch (err) {
      logger.error("page range subset failed", { ...logContext, pageRange: pageRangeText, error: err instanceof Error ? err.message : String(err) });
      return error(
        "subset_failed",
        "Those pages couldn't be pulled out of this PDF. Print the whole document, or re-export it (Print → Save as PDF) and try again.",
      );
    }
    workingBytes = subsetBytes;
  }

  let derivedBytes: Uint8Array | null = subsetBytes ?? sanitized;
  let effectivePageCount = sourcePages;
  let blankPagesAdded = 0;

  if (held) {
    // Held jobs print nothing yet: no imposition, only the originals and an estimate. The sender (or an admin) finishes it later
    // from the stored original and page range.
    derivedBytes = null;
    if (booklet) effectivePageCount = computeBookletPadding(sourcePages).paddedPages;
    else if (layout) effectivePageCount = layoutSheetCount(layout, sourcePages);
  } else if (layout) {
    // Several pages per sheet / repeated page: the output has one physical page (side) per sheet, and that is what print math counts.
    try {
      const built = await buildLayoutPdf(workingBytes, layout, input.bookletOptions.paperSize);
      effectivePageCount = built.sheets;
      derivedBytes = built.bytes;
    } catch (err) {
      logger.error("page layout failed", { ...logContext, sourcePages, layout: layout.kind, error: err instanceof Error ? err.message : String(err) });
      return error(
        "booklet_failed",
        err instanceof LayoutError
          ? err.message
          : "This PDF couldn't be laid out with several pages per sheet. Try printing it without that option, or re-export it (Print → Save as PDF) and submit again.",
      );
    }
  } else if (booklet) {
    const padding = computeBookletPadding(sourcePages);
    if (padding.needsPadding && !input.confirmBookletPadding) {
      return {
        ok: false,
        kind: "needs_booklet_confirm",
        needsBookletConfirm: { sourcePages, paddedPages: padding.paddedPages, blankPagesAdded: padding.blankPagesAdded },
      };
    }
    // Always pad (a no-op when already a multiple of 4) and then impose: real N-up saddle-stitch imposition with per-page independent
    // scaling (docs/architecture.md sec 8). Wrapped because pdf-lib can throw on a document that nonetheless passed preflight; nothing
    // has been reserved or uploaded at this point, so returning is a clean stop.
    try {
      const built = await padAndImposeBooklet(workingBytes, {
        paperSize: input.bookletOptions.paperSize,
        bindingSide: input.bookletOptions.bindingSide,
        fit: input.bookletOptions.fit,
        sheet: input.bookletOptions.sheet,
      });
      effectivePageCount = built.paddedPages;
      blankPagesAdded = built.blankPagesAdded;
      derivedBytes = built.bytes;
    } catch (err) {
      logger.error("booklet imposition failed", {
        ...logContext,
        sourcePages,
        paperSize: input.bookletOptions.paperSize,
        bindingSide: input.bookletOptions.bindingSide,
        error: err instanceof Error ? err.message : String(err),
      });
      return error(
        "booklet_failed",
        "This PDF couldn't be laid out as a booklet. Try printing it without the Booklet option, or re-export it (Print → Save as PDF) and submit again.",
      );
    }
  }

  // The user code stamp: applied LAST, to the final file that will print (after page range, padding and booklet imposition), so it lands
  // on page 1 of the first sheet side. A held job prints nothing yet and is stamped when it is released. The stored original is never
  // stamped. If stamping fails the job still goes through unstamped.
  if (input.stamp && !held) {
    try {
      const stamp = typeof input.stamp === "function" ? await input.stamp() : input.stamp;
      if (stamp) derivedBytes = await stampFirstPage(derivedBytes ?? sourceBytes, stamp);
    } catch (err) {
      logger.error("user code stamp failed; printing without it", { ...logContext, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Text safeguard: whatever the steps above did, the file that prints must say what the upload said. Only runs when there is a derived
  // file and the original has non-Latin text (Hebrew etc.); fails open. A real mismatch holds the job with a plain reason. A picture copy
  // has no text by design, so the check is skipped for those.
  if (!held && derivedBytes && !pictureCopy) {
    const fidelity = await checkTextFidelity({
      original: pdfInput,
      derived: derivedBytes,
      sourcePages: plan.subsetPages ?? null,
      booklet,
      ...(layout ? { groups: layoutSheetGroups(layout, sourcePages) } : {}),
    });
    if (fidelity.status === "changed") {
      logger.error("derived PDF text differs from the upload; job held", { ...logContext, page: fidelity.page, booklet, pageRange: pageRangeText });
      heldReason = TEXT_CHANGED_MESSAGE;
      held = true;
      derivedBytes = null;
      effectivePageCount = booklet ? computeBookletPadding(sourcePages).paddedPages : layout ? layoutSheetCount(layout, sourcePages) : sourcePages;
    } else if (fidelity.status === "skipped" && fidelity.reason !== "no non-Latin text") {
      logger.warn("text check skipped", { ...logContext, reason: fidelity.reason });
    }
  }

  // Last line of defence (security review F1): nothing that would be streamed to a printer may carry its escape sequences.
  if (derivedBytes && containsPjlEscape(derivedBytes)) return error("bad_pdf", PJL_ESCAPE_MESSAGE);

  return {
    ok: true,
    held,
    heldReason,
    derivedBytes,
    effectivePageCount,
    blankPagesAdded,
    sourcePages,
    pageRangeText,
    fileSizeBytes: imagePdf ? originalBytes.byteLength : preflight.fileSizeBytes,
    pictureCopy: pictureCopy !== null,
  };
}
