/**
 * Pure maths for content-aware booklets (no PDF library, no I/O): one crop rectangle per page that removes the
 * document's own blank margins, and the placement of a cropped page into a booklet cell.
 *
 * Why this exists: a Word / Google Docs page carries about 1 inch of its own blank margin. Scaling the whole page
 * into a statement-size cell (5.5 x 8.5 in) shrinks those margins too, so the real text ends up around 60% size
 * with a wide empty border. Cropping every page by the SAME margins first (the margins of the page that reaches
 * furthest out) lets the content fill the cell while text keeps one consistent size across the whole booklet.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What the analysis learned about one page: its ink box, "nothing on it", or "could not tell" (never guessed). */
export type PageContent = { kind: "content"; box: Box } | { kind: "blank" } | { kind: "unknown" };

/** Clearance added around the union of all content, so antialiasing, descenders and hairlines are never touched. */
export const CROP_SAFETY_PAD_PT = 4;

/** Cropping never removes more than this share of a page's width, nor of its height (in total, both sides). */
export const MAX_CROP_FRACTION = 0.4;

/** A cropped page may be enlarged more than a whole page (its crop is smaller), but not without limit. */
export const FILL_MAX_UPSCALE = 3;

export interface CropOptions {
  padPt?: number;
  maxCropFraction?: number;
}

const clamp0 = (n: number) => (n > 0 ? n : 0);

/**
 * The crop rectangle of every page, or null for "do not crop" (any page that could not be analysed, or no page
 * with content at all). The crop is expressed as per-side insets shared by the whole document: for each side,
 * the smallest gap between the page edge and the content on any page (the union of all content), minus the
 * safety pad. Pages of the same size therefore get the identical crop and, in turn, the identical scale; a page
 * with a header, a footer or a page number keeps them. Blank pages (booklet padding) are cropped like the rest.
 *
 * Safety: the crop never leaves the page box, and never removes more than `maxCropFraction` of a page's width or
 * of its height (when it would, both sides of that axis are reduced in proportion).
 */
export function computeUniformCrop(pages: Array<{ page: Box; content: PageContent }>, options: CropOptions = {}): Box[] | null {
  const pad = options.padPt ?? CROP_SAFETY_PAD_PT;
  const maxFraction = options.maxCropFraction ?? MAX_CROP_FRACTION;
  if (pages.length === 0) return null;
  if (pages.some((p) => p.content.kind === "unknown")) return null;

  let left = Infinity;
  let bottom = Infinity;
  let right = Infinity;
  let top = Infinity;
  let any = false;
  for (const { page, content } of pages) {
    if (content.kind !== "content") continue;
    any = true;
    const b = content.box;
    left = Math.min(left, clamp0(b.x0 - page.x0));
    bottom = Math.min(bottom, clamp0(b.y0 - page.y0));
    right = Math.min(right, clamp0(page.x1 - b.x1));
    top = Math.min(top, clamp0(page.y1 - b.y1));
  }
  if (!any) return null;
  left = clamp0(left - pad);
  bottom = clamp0(bottom - pad);
  right = clamp0(right - pad);
  top = clamp0(top - pad);

  return pages.map(({ page }) => {
    const w = page.x1 - page.x0;
    const h = page.y1 - page.y0;
    let l = left;
    let r = right;
    let b = bottom;
    let t = top;
    if (l + r > maxFraction * w) {
      const k = (maxFraction * w) / (l + r);
      l *= k;
      r *= k;
    }
    if (b + t > maxFraction * h) {
      const k = (maxFraction * h) / (b + t);
      b *= k;
      t *= k;
    }
    return { x0: page.x0 + l, y0: page.y0 + b, x1: page.x1 - r, y1: page.y1 - t };
  });
}

export interface CellRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where, and how large, to draw a page whose visible part is `crop` (width x height) inside a cell: uniform scale
 * (aspect kept) so the crop touches the limiting edge of the cell, centered; enlarged up to `maxUpscale`.
 * The returned x/y is the position of the crop's own lower-left corner (the embedded page is origin-shifted).
 */
export function computeCroppedSlotTransform(
  crop: { width: number; height: number },
  region: CellRegion,
  maxUpscale: number = FILL_MAX_UPSCALE,
): { x: number; y: number; scale: number } {
  const fit = Math.min(region.width / crop.width, region.height / crop.height);
  const scale = Math.min(fit, maxUpscale);
  return {
    x: region.x + (region.width - crop.width * scale) / 2,
    y: region.y + (region.height - crop.height * scale) / 2,
    scale,
  };
}
