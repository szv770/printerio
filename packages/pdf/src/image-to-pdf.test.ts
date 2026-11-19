import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from "pdf-lib";
import { detectImageKind, imageToPdf, orientedMatrix, placeImage, readExifOrientation, readJpegInfo } from "./image-to-pdf";

function u16(n: number, le: boolean): number[] {
  return le ? [n & 255, n >> 8] : [n >> 8, n & 255];
}
function u32(n: number, le: boolean): number[] {
  return le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255] : [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A JPEG skeleton (header segments only, no picture data): enough for the size and orientation readers and for pdf-lib to embed. */
function jpeg(w: number, h: number, orientation?: number, le = true): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42, le), ...u32(8, le), ...u16(1, le), ...u16(0x0112, le), ...u16(3, le), ...u32(1, le), ...u16(orientation, le), 0, 0, ...u32(0, le)];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    out.push(0xff, 0xe1, ...u16(body.length + 2, false), ...body);
  }
  out.push(0xff, 0xc0, 0, 17, 8, ...u16(h, false), ...u16(w, false), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
/** A real PNG: RGBA (colour type 6) or RGB (2), every pixel the same colour. */
function png(w: number, h: number, rgba?: [number, number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = rgba ? 6 : 2;
  const bpp = rgba ? 4 : 3;
  const row = Buffer.alloc(1 + w * bpp);
  for (let x = 0; x < w; x++) for (let c = 0; c < bpp; c++) row[1 + x * bpp + c] = rgba ? rgba[c]! : [200, 30, 30][c]!;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Uint8Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const LIMIT = 10 * 1024 * 1024;

describe("image detection and EXIF", () => {
  it("is decided by the first bytes, not the name", () => {
    expect(detectImageKind(jpeg(10, 10))).toBe("jpeg");
    expect(detectImageKind(png(2, 2))).toBe("png");
    expect(detectImageKind(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
  });

  it("reads orientation 1-8 from little- and big-endian EXIF, and 1 when there is none", () => {
    for (let o = 1; o <= 8; o++) {
      expect(readJpegInfo(jpeg(40, 20, o, true))?.orientation).toBe(o);
      expect(readJpegInfo(jpeg(40, 20, o, false))?.orientation).toBe(o);
    }
    expect(readJpegInfo(jpeg(40, 20))).toMatchObject({ width: 40, height: 20, orientation: 1 });
    expect(readExifOrientation(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readJpegInfo(jpeg(40, 20, 9))?.orientation).toBe(1); // out of range is ignored
  });
});

describe("orientation maths", () => {
  const rect = { x: 0, y: 0, width: 100, height: 200 };
  const apply = (m: number[], u: number, v: number): [number, number] => [m[0]! * u + m[2]! * v + m[4]!, m[1]! * u + m[3]! * v + m[5]!];
  const where = ([x, y]: [number, number]) => `${x === 0 ? "left" : "right"}-${y === 200 ? "top" : "bottom"}`;
  // Where the stored top-left and top-right corners must appear (EXIF spec).
  const expected: Record<number, [string, string]> = {
    1: ["left-top", "right-top"],
    2: ["right-top", "left-top"],
    3: ["right-bottom", "left-bottom"],
    4: ["left-bottom", "right-bottom"],
    5: ["left-top", "left-bottom"],
    6: ["right-top", "right-bottom"],
    7: ["right-bottom", "right-top"],
    8: ["left-bottom", "left-top"],
  };
  for (let o = 1; o <= 8; o++) {
    it(`orientation ${o}: stored top-left and top-right land where EXIF says`, () => {
      const m = orientedMatrix(o, rect);
      expect([where(apply(m, 0, 1)), where(apply(m, 1, 1))]).toEqual(expected[o]);
    });
  }

  it("fit stays inside the area, fill covers it, actual never exceeds the area", () => {
    const area = { x: 18, y: 18, width: 576, height: 756 };
    const wide = { width: 4000, height: 1000 };
    const fit = placeImage(area, wide, "fit", { x: 96, y: 96 });
    expect(fit.width).toBeCloseTo(576);
    expect(fit.height).toBeLessThan(756);
    const fill = placeImage(area, wide, "fill", { x: 96, y: 96 });
    expect(fill.height).toBeCloseTo(756);
    expect(fill.width).toBeGreaterThan(576);
    const small = placeImage(area, { width: 96, height: 96 }, "actual", { x: 96, y: 96 });
    expect(small.width).toBeCloseTo(72); // one inch
    expect(placeImage(area, wide, "actual", { x: 96, y: 96 }).width).toBeLessThanOrEqual(576 + 1e-6);
  });
});

describe("imageToPdf", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("a landscape JPEG makes one landscape page; an EXIF-rotated one (6) makes a portrait page", async () => {
    const plain = await imageToPdf(jpeg(400, 200), { maxBytes: LIMIT });
    const rotated = await imageToPdf(jpeg(400, 200, 6), { maxBytes: LIMIT });
    expect(plain.ok && rotated.ok).toBe(true);
    if (!plain.ok || !rotated.ok) return;
    const a = (await PDFDocument.load(plain.bytes)).getPage(0).getSize();
    const b = (await PDFDocument.load(rotated.bytes)).getPage(0).getSize();
    expect(a.width).toBeGreaterThan(a.height);
    expect(b.height).toBeGreaterThan(b.width);
    expect(rotated.orientation).toBe(6);
  });

  it("paper size and margin: nothing is drawn closer than 14pt to the edge", async () => {
    const r = await imageToPdf(png(300, 400), { maxBytes: LIMIT, paperSize: "a4", margin: 0, fit: "fit" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const page = (await PDFDocument.load(r.bytes)).getPage(0);
    expect(page.getSize().width).toBeCloseTo(595.28);
    expect(page.getSize().height).toBeCloseTo(841.89);
  });

  it("a picture over the pixel cap is refused before it is decoded, with a plain message", async () => {
    const r = await imageToPdf(png(10_000, 10_000), { maxBytes: LIMIT });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/too large to print/);
    const j = await imageToPdf(jpeg(9000, 9000), { maxBytes: LIMIT });
    expect(j.ok).toBe(false);
  });

  it("a file over the byte limit is refused with the upload-limit wording", async () => {
    const r = await imageToPdf(jpeg(10, 10), { maxBytes: 20 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/upload limit/);
  });

  it("a PNG with transparency gets a white backing under it; one without does not", async () => {
    const withAlpha = await imageToPdf(png(8, 8, [255, 0, 0, 0]), { maxBytes: LIMIT });
    const opaque = await imageToPdf(png(8, 8), { maxBytes: LIMIT });
    if (!withAlpha.ok || !opaque.ok) throw new Error("expected both to convert");
    const content = async (b: Uint8Array) => {
      const doc = await PDFDocument.load(b);
      const c = doc.getPage(0).node.Contents();
      const streams = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, i) => doc.context.lookup(c.get(i))) : [c];
      return streams.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString("latin1")).join("\n");
    };
    expect(await content(withAlpha.bytes)).toMatch(/1 1 1 rg[\s\S]*re[\s\S]*f[\s\S]*\/Im0 Do/);
    expect(await content(opaque.bytes)).not.toMatch(/1 1 1 rg/);
  });

  it("garbage that starts like a JPEG but has no size is refused, not thrown", async () => {
    const r = await imageToPdf(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { maxBytes: LIMIT });
    expect(r.ok).toBe(false);
  });
});
