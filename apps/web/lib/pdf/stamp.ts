import "server-only";
import { PDFDocument, StandardFonts, degrees, grayscale, type PDFPage } from "pdf-lib";
import type { StampStrength } from "@/lib/jobs/user-code";

/** Small, so it never competes with content; 6-7 pt reads fine on a 600 dpi laser print. */
export const STAMP_FONT_SIZE_PT = 6.5;
/** Distance from the visible top and right edges. Outside any normal document margin (>= 0.5in) and the printer's unprintable edge. */
export const STAMP_INSET_PT = 20;
/** Fill grey levels (0 black .. 1 white). */
export const STAMP_GREY: Record<StampStrength, number> = { light: 0.6, medium: 0.4, strong: 0.2 };

function cleanText(text: string): string {
  // A standard font only draws WinAnsi; keep printable ASCII and drop the rest so a stray character can never throw.
  return text.replace(/[^\x20-\x7e]/g, "").trim();
}

/** The page's visible box in unrotated user space: CropBox when present (pdf-lib falls back to MediaBox), clipped to the MediaBox. */
function visibleBox(page: PDFPage) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const left = Math.max(media.x, crop.x);
  const bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  if (right - left > 1 && top - bottom > 1) return { left, bottom, right, top };
  return { left: media.x, bottom: media.y, right: media.x + media.width, top: media.y + media.height };
}

/**
 * Stamps `text` small and grey in the visually top-right corner of page 1 only. Everything else is untouched:
 * page count, page sizes, boxes and /Rotate stay as they were (the text is just appended to page 1's content,
 * which pdf-lib wraps in q/Q so a content stream with a leftover transform cannot misplace it).
 *
 * Call it on the FINAL file to be printed (after page range, padding and booklet imposition), so "page 1" is the
 * first sheet side that comes out of the printer. Returns the input bytes untouched when there is nothing to stamp.
 * Throws on a PDF pdf-lib cannot load/save; the caller decides whether to print without the stamp.
 */
export async function stampFirstPage(
  bytes: Uint8Array,
  opts: { text: string; strength?: StampStrength },
): Promise<Uint8Array> {
  const text = cleanText(opts.text);
  if (!text) return bytes;

  const doc = await PDFDocument.load(bytes);
  if (doc.getPageCount() === 0) return bytes;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(0);

  const box = visibleBox(page);
  const rotation = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const boxW = box.right - box.left;
  const boxH = box.top - box.bottom;
  // Size of the page as the viewer / printer shows it (a /Rotate of 90 or 270 swaps width and height).
  const W = rotation === 90 || rotation === 270 ? boxH : boxW;
  const H = rotation === 90 || rotation === 270 ? boxW : boxH;

  const textWidth = font.widthOfTextAtSize(text, STAMP_FONT_SIZE_PT);
  // Baseline-left of the text in DISPLAY space (origin bottom-left, y up), so its right edge sits on the inset line.
  const dx = Math.max(STAMP_INSET_PT / 2, W - STAMP_INSET_PT - textWidth);
  const dy = H - STAMP_INSET_PT - STAMP_FONT_SIZE_PT;

  // Display space -> unrotated user space. /Rotate turns the page clockwise when shown.
  let x: number;
  let y: number;
  switch (rotation) {
    case 90:
      x = box.right - dy;
      y = box.bottom + dx;
      break;
    case 180:
      x = box.right - dx;
      y = box.top - dy;
      break;
    case 270:
      x = box.left + dy;
      y = box.top - dx;
      break;
    default:
      x = box.left + dx;
      y = box.bottom + dy;
  }

  page.drawText(text, {
    x,
    y,
    size: STAMP_FONT_SIZE_PT,
    font,
    color: grayscale(STAMP_GREY[opts.strength ?? "light"]),
    rotate: degrees(rotation),
  });
  return doc.save();
}
