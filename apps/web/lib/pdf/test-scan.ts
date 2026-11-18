// Test helper: builds a PDF whose pages are ONE full-page image (like a scan), with dark ink only inside a given
// rectangle (in page fractions, origin top-left). No native code: the PNG is encoded by hand with zlib.
import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** 8-bit grayscale PNG, `ink` decides each pixel (0 = black, 255 = white). */
export function grayPng(w: number, h: number, pixel: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = pixel(x, y);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

export interface ScanPage {
  width: number;
  height: number;
  /** Where the ink is, as fractions of the page, origin top-left. null = a blank white scan. */
  ink: { x0: number; y0: number; x1: number; y1: number } | null;
}

export async function scanPdf(pages: ScanPage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const pxW = 200;
    const pxH = Math.round((200 * p.height) / p.width);
    const png = grayPng(pxW, pxH, (x, y) => {
      if (!p.ink) return 255;
      const fx = x / pxW;
      const fy = y / pxH;
      return fx >= p.ink.x0 && fx <= p.ink.x1 && fy >= p.ink.y0 && fy <= p.ink.y1 ? 20 : 255;
    });
    const img = await doc.embedPng(png);
    const page = doc.addPage([p.width, p.height]);
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
  }
  return doc.save();
}
