import { PDFDocument, PDFOperator, PDFOperatorNames, PDFNumber, PDFName, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { LAYOUT_MIN_MARGIN_PT } from "./nup";
import { resolvePaperSizePoints } from "./imposition";

/**
 * Turns a JPEG or PNG into a one-page PDF so a photo or scan goes through the normal pipeline (page range, layout, stamp, print math).
 * Detection is by magic bytes, never by file name. Sizes are read from the file header BEFORE anything is decoded, so a small file that
 * claims a gigantic picture (a decompression bomb) is refused cheaply.
 */

export const IMAGE_MAX_PIXELS = 40_000_000;
export type ImageKind = "jpeg" | "png";
export type ImageFit = "fit" | "fill" | "actual";

export interface ImageToPdfOptions {
  /** "fit" (default): whole picture inside the margins. "fill": covers the area inside the margins, edges cut off. "actual": print size from the file's resolution (never bigger than the area). */
  fit?: ImageFit;
  paperSize?: string;
  /** Points; never below 14. Default 18. */
  margin?: number;
  /** The organization's upload limit in bytes. */
  maxBytes: number;
  maxPixels?: number;
}

export type ImageToPdfResult = { ok: true; bytes: Uint8Array; widthPx: number; heightPx: number; orientation: number } | { ok: false; reason: string };

const DEFAULT_MARGIN_PT = 18;
const DEFAULT_DPI = 96;

export function detectImageKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  return null;
}

interface ImageInfo {
  width: number;
  height: number;
  /** EXIF orientation 1-8 (JPEG only). */
  orientation: number;
  dpiX: number | null;
  dpiY: number | null;
}

/** Walks the JPEG segments: size from the SOF marker, orientation from EXIF (APP1), resolution from JFIF (APP0). Returns null if it cannot find a size. */
export function readJpegInfo(b: Uint8Array): ImageInfo | null {
  let width = 0;
  let height = 0;
  let orientation = 1;
  let dpiX: number | null = null;
  let dpiY: number | null = null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan: no more headers worth reading
    const len = dv.getUint16(p + 2);
    const seg = p + 4;
    if (len < 2 || seg + len - 2 > b.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len >= 7) {
        height = dv.getUint16(seg + 1);
        width = dv.getUint16(seg + 3);
      }
    } else if (marker === 0xe1) {
      orientation = readExifOrientation(b.subarray(seg, seg + len - 2)) ?? orientation;
    } else if (marker === 0xe0 && len >= 16 && b[seg] === 0x4a && b[seg + 1] === 0x46 && b[seg + 2] === 0x49 && b[seg + 3] === 0x46) {
      const units = b[seg + 7];
      const xd = dv.getUint16(seg + 8);
      const yd = dv.getUint16(seg + 10);
      if (units === 1 && xd > 0 && yd > 0) {
        dpiX = xd;
        dpiY = yd;
      } else if (units === 2 && xd > 0 && yd > 0) {
        dpiX = xd * 2.54;
        dpiY = yd * 2.54;
      }
    }
    p = seg + len - 2;
  }
  return width > 0 && height > 0 ? { width, height, orientation, dpiX, dpiY } : null;
}

/** The EXIF orientation (1-8) in an APP1 segment body, or null when there is none or it is not understood. */
export function readExifOrientation(app1: Uint8Array): number | null {
  if (app1.length < 14 || String.fromCharCode(...app1.subarray(0, 4)) !== "Exif" || app1[4] !== 0 || app1[5] !== 0) return null;
  const dv = new DataView(app1.buffer, app1.byteOffset, app1.byteLength);
  const le = app1[6] === 0x49 && app1[7] === 0x49;
  if (!le && !(app1[6] === 0x4d && app1[7] === 0x4d)) return null;
  const tiff = 6;
  if (dv.getUint16(tiff + 2, le) !== 42) return null;
  const ifd = tiff + dv.getUint32(tiff + 4, le);
  if (ifd + 2 > app1.length) return null;
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > app1.length) return null;
    if (dv.getUint16(e, le) === 0x0112) {
      if (dv.getUint16(e + 2, le) !== 3 || dv.getUint32(e + 4, le) < 1) return null;
      const v = dv.getUint16(e + 8, le);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** Size and resolution from a PNG header (IHDR, pHYs); null when it is not a readable PNG header. */
export function readPngInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 33 || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (width === 0 || height === 0) return null;
  let dpiX: number | null = null;
  let dpiY: number | null = null;
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    if (type === "IDAT" || type === "IEND") break;
    if (type === "pHYs" && len === 9 && b[p + 16] === 1) {
      const x = dv.getUint32(p + 8);
      const y = dv.getUint32(p + 12);
      if (x > 0 && y > 0) {
        dpiX = x * 0.0254;
        dpiY = y * 0.0254;
      }
    }
    p += 12 + len;
  }
  return { width, height, orientation: 1, dpiX, dpiY };
}

/** Does this PNG carry transparency (alpha channel or a tRNS chunk)? */
export function pngHasAlpha(b: Uint8Array): boolean {
  const colorType = b[25];
  if (colorType === 4 || colorType === 6) return true;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") break;
    p += 12 + len;
  }
  return false;
}

/**
 * The matrix [a b c d e f] that draws a stored image (unit square, upright as stored) into `rect` as an EXIF `orientation` says it should be seen.
 * Orientation 1 normal, 2 mirrored left-right, 3 turned 180, 4 mirrored top-bottom, 5 transposed, 6 turned 90 clockwise, 7 transverse, 8 turned 90 counter-clockwise.
 * `rect` is the DISPLAYED rectangle (already swapped for 5-8).
 */
export function orientedMatrix(orientation: number, rect: { x: number; y: number; width: number; height: number }): [number, number, number, number, number, number] {
  // Where the stored point (c across from the left, r down from the top) ends up, as a fraction across (X) and down (rd) the displayed picture.
  const map = (c: number, r: number): [number, number] => {
    switch (orientation) {
      case 2: return [1 - c, r];
      case 3: return [1 - c, 1 - r];
      case 4: return [c, 1 - r];
      case 5: return [r, c];
      case 6: return [1 - r, c];
      case 7: return [1 - r, 1 - c];
      case 8: return [r, 1 - c];
      default: return [c, r];
    }
  };
  // PDF image space: u right, v up; the top row of the stored picture is v = 1, so r = 1 - v.
  const at = (u: number, v: number): [number, number] => {
    const [X, rd] = map(u, 1 - v);
    return [rect.x + X * rect.width, rect.y + (1 - rd) * rect.height];
  };
  const [e, f] = at(0, 0);
  const [ux, uy] = at(1, 0);
  const [vx, vy] = at(0, 1);
  return [ux - e, uy - f, vx - e, vy - f, e, f];
}

/** Where the picture goes on the page, for the three fit modes. `disp` is the displayed picture size in pixels, `dpi` its print resolution. */
export function placeImage(
  area: { x: number; y: number; width: number; height: number },
  disp: { width: number; height: number },
  fit: ImageFit,
  dpi: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  const toFit = Math.min(area.width / disp.width, area.height / disp.height);
  const toCover = Math.max(area.width / disp.width, area.height / disp.height);
  // Points per pixel: "actual" uses the file's own resolution but is never larger than the area allows.
  const scale = fit === "fill" ? toCover : fit === "actual" ? Math.min(72 / dpi.x, toFit) : toFit;
  const width = disp.width * scale;
  const height = disp.height * scale;
  return { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height };
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);

export async function imageToPdf(bytes: Uint8Array, opts: ImageToPdfOptions): Promise<ImageToPdfResult> {
  const kind = detectImageKind(bytes);
  if (!kind) return { ok: false, reason: "This file isn't a JPEG or PNG picture." };
  if (bytes.byteLength > opts.maxBytes) return { ok: false, reason: `File exceeds this organization's ${mb(opts.maxBytes)} MB upload limit.` };
  const info = kind === "jpeg" ? readJpegInfo(bytes) : readPngInfo(bytes);
  if (!info) return { ok: false, reason: "We couldn't read this picture. Open it and save it again as a JPEG or PNG." };
  const maxPixels = opts.maxPixels ?? IMAGE_MAX_PIXELS;
  if (info.width * info.height > maxPixels) {
    return { ok: false, reason: `This picture is too large to print (${Math.round((info.width * info.height) / 1e6)} megapixels; the limit is ${Math.round(maxPixels / 1e6)}). Make it smaller and try again.` };
  }
  try {
    const doc = await PDFDocument.create();
    const image = kind === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const swap = info.orientation >= 5;
    const disp = swap ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
    const paper = resolvePaperSizePoints(opts.paperSize ?? "letter");
    const short = Math.min(paper.width, paper.height);
    const long = Math.max(paper.width, paper.height);
    const landscape = disp.width > disp.height;
    const sheet = landscape ? { width: long, height: short } : { width: short, height: long };
    const margin = Math.max(opts.margin ?? DEFAULT_MARGIN_PT, LAYOUT_MIN_MARGIN_PT);
    const area = { x: margin, y: margin, width: sheet.width - 2 * margin, height: sheet.height - 2 * margin };
    const fit = opts.fit ?? "fit";
    const swapDpi = swap ? { x: info.dpiY, y: info.dpiX } : { x: info.dpiX, y: info.dpiY };
    const rect = placeImage(area, disp, fit, { x: swapDpi.x ?? DEFAULT_DPI, y: swapDpi.y ?? DEFAULT_DPI });
    const page = doc.addPage([sheet.width, sheet.height]);
    const name = PDFName.of("Im0");
    page.node.setXObject(name, image.ref);
    const ops = [pushGraphicsState()];
    if (fit === "fill") {
      // Cover the printable area and cut off what sticks out of it.
      ops.push(PDFOperator.of(PDFOperatorNames.AppendRectangle, [PDFNumber.of(area.x), PDFNumber.of(area.y), PDFNumber.of(area.width), PDFNumber.of(area.height)]), PDFOperator.of(PDFOperatorNames.ClipNonZero), PDFOperator.of(PDFOperatorNames.EndPath));
    }
    if (kind === "png" && pngHasAlpha(bytes)) {
      // Flatten on white: see-through parts print as white paper in every viewer and printer, never black.
      ops.push(
        PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, [PDFNumber.of(1), PDFNumber.of(1), PDFNumber.of(1)]),
        PDFOperator.of(PDFOperatorNames.AppendRectangle, [PDFNumber.of(rect.x), PDFNumber.of(rect.y), PDFNumber.of(rect.width), PDFNumber.of(rect.height)]),
        PDFOperator.of(PDFOperatorNames.FillNonZero),
      );
    }
    const [a, b, c, d, e, f] = orientedMatrix(info.orientation, rect);
    ops.push(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), drawObject(name), popGraphicsState(), popGraphicsState());
    page.pushOperators(...ops);
    return { ok: true, bytes: await doc.save(), widthPx: info.width, heightPx: info.height, orientation: info.orientation };
  } catch {
    return { ok: false, reason: "We couldn't read this picture. Open it and save it again as a JPEG or PNG." };
  }
}
