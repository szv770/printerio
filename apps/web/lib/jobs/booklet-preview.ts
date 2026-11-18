import "server-only";
import { preflightPdf } from "@/lib/pdf/preflight";
import { createPageSubsetPdf } from "@/lib/pdf/page-subset";
import { stampFirstPage } from "@/lib/pdf/stamp";
import { padAndImposeBooklet, type BookletSheet } from "@/lib/pdf/booklet-build";
import type { BindingSide, BookletFit } from "@/lib/pdf/imposition";
import { planPageSubset } from "@/lib/print-choices";
import type { StampStrength } from "@/lib/jobs/user-code";

/** The imposed preview is handed over as a signed storage URL (not in the response body), so only the browser's render time bounds it. */
export const MAX_PREVIEW_PDF_BYTES = 15_000_000;
/** Source files above this are not previewed (the print itself is unaffected). */
export const MAX_PREVIEW_SOURCE_BYTES = 20 * 1024 * 1024;

export type BookletPreviewResult =
  | { ok: true; bytes: Uint8Array; sourcePages: number; paddedPages: number; blankPagesAdded: number; sheets: number }
  | { ok: false; error: string; fieldErrors?: { pageRange?: string } };

/**
 * The same steps a booklet job goes through (preflight and sanitize, page range, padding, imposition with the chosen
 * fit and binding side, the page-1 stamp) but nothing is stored and no job exists. Blank pages are always added
 * (the preview answers the padding question as "with blank pages"). Pure of auth, rate limits and settings: the
 * server action around it owns those.
 */
export async function buildBookletPreviewPdf(
  originalBytes: Uint8Array,
  o: {
    maxSizeBytes: number;
    pageRangeText: string | null;
    paperSize: string;
    bindingSide: BindingSide;
    fit: BookletFit;
    /** "tabloid" = Letter pages at full size on an 11x17 sheet (see lib/pdf/booklet-build.ts). Default regular. */
    sheet?: BookletSheet;
    stamp?: { text: string; strength: StampStrength } | null;
  },
): Promise<BookletPreviewResult> {
  if (originalBytes.byteLength > Math.min(o.maxSizeBytes, MAX_PREVIEW_SOURCE_BYTES)) {
    return { ok: false, error: "This file is too large to preview here. You can still print it." };
  }
  const preflight = await preflightPdf(originalBytes, { maxSizeBytes: o.maxSizeBytes });
  if (!preflight.ok) return { ok: false, error: preflight.reason };
  const source = preflight.sanitizedBytes ?? originalBytes;

  const plan = planPageSubset({ pageRangeText: o.pageRangeText, pageCount: preflight.pageCount, held: false });
  if (!plan.ok) return { ok: false, error: plan.reason, fieldErrors: { pageRange: plan.reason } };

  try {
    const working = plan.subsetPages ? await createPageSubsetPdf(source, plan.subsetPages) : source;
    const built = await padAndImposeBooklet(working, { paperSize: o.paperSize, bindingSide: o.bindingSide, fit: o.fit, sheet: o.sheet });
    let bytes = built.bytes;
    if (o.stamp) {
      try {
        bytes = await stampFirstPage(bytes, { text: o.stamp.text, strength: o.stamp.strength });
      } catch {
        /* the stamp is a label; a preview without it is still the right preview */
      }
    }
    if (bytes.byteLength > MAX_PREVIEW_PDF_BYTES) {
      return { ok: false, error: "This booklet is too large to preview here. You can still print it." };
    }
    return { ok: true, bytes, sourcePages: plan.sourcePages, paddedPages: built.paddedPages, blankPagesAdded: built.blankPagesAdded, sheets: built.paddedPages / 4 };
  } catch {
    return { ok: false, error: "This PDF couldn't be laid out as a booklet. Try re-exporting it (Print, then Save as PDF) and submit again." };
  }
}
