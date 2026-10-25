import { computeBookletPadding } from "@printio/shared";

/** The one-line, no-question message shown for a booklet: blank pages are simply added at the end. null = nothing to say. */
export function bookletBlankPagesNote(pages: number | null): string | null {
  if (!pages || !Number.isInteger(pages) || pages <= 0) return null;
  const { blankPagesAdded, paddedPages } = computeBookletPadding(pages);
  if (blankPagesAdded === 0) return null;
  return `Adding ${blankPagesAdded} blank ${blankPagesAdded === 1 ? "page" : "pages"} at the end to fill the booklet (${pages} → ${paddedPages} pages).`;
}
