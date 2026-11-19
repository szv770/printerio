/// <reference path="./pdfjs-worker.d.ts" />
import { deflateSync } from "node:zlib";
import { PICTURE_COPY_MAX_PAGES as RASTERIZE_MAX_PAGES } from "./type3-fonts";
import { PDFDocument, PDFRawStream, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";

/**
 * Turns a PDF whose fonts the office printer cannot read safely (Type 3, see type3-fonts.ts) into a PDF of
 * pictures: every page is drawn by pdf.js on the server and stored as one grey (or colour) image at the same page
 * size. The printer then never sees the fonts. It printed fine when the owner did this by hand on 2026-11-15.
 *
 * Limits keep one upload from hogging the server: at most MAX_PAGES pages and a total time budget. Over either, the
 * caller falls back to holding the job with the plain message. Text is no longer selectable in the converted copy
 * (the stored original is untouched); that does not matter on paper.
 */


const TIME_BUDGET_MS = 90_000;
const GRAY_DPI = 300;
const COLOR_DPI = 200;
/** Largest pixel count per page (guards a huge page size). Letter at 300 dpi is about 8.4 million. */
const MAX_PIXELS = 20_000_000;

export type RasterizeResult = { ok: true; bytes: Uint8Array; pages: number } | { ok: false; reason: string };

interface CanvasLike {
  canvas: unknown;
  context: { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } };
}
interface PdfjsPage {
  view: number[];
  rotate: number;
  getViewport: (p: { scale: number }) => { width: number; height: number };
  render: (p: Record<string, unknown>) => { promise: Promise<void> };
  cleanup: () => void;
}
interface PdfjsDoc {
  canvasFactory?: { create: (w: number, h: number) => CanvasLike; destroy: (c: CanvasLike) => void };
  numPages: number;
  getPage: (n: number) => Promise<PdfjsPage>;
  destroy: () => Promise<void>;
}
interface PdfjsModule {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfjsDoc> };
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  })();
  return pdfjsPromise;
}

/** RGBA (composited on white) to packed grey or RGB, ready to be deflated into a PDF image. */
export function packPixels(rgba: Uint8ClampedArray, pixels: number, color: boolean): Uint8Array {
  const out = new Uint8Array(pixels * (color ? 3 : 1));
  for (let i = 0, o = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    const r = rgba[i * 4]! * a + 255 * (1 - a);
    const g = rgba[i * 4 + 1]! * a + 255 * (1 - a);
    const b = rgba[i * 4 + 2]! * a + 255 * (1 - a);
    if (color) {
      out[o++] = r;
      out[o++] = g;
      out[o++] = b;
    } else {
      out[o++] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return out;
}

export async function rasterizePdf(bytes: Uint8Array, opts: { color: boolean }): Promise<RasterizeResult> {
  let doc: PdfjsDoc | null = null;
  try {
    const pdfjs = await loadPdfjs();
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: false,
    }).promise;
    if (doc.numPages > RASTERIZE_MAX_PAGES) return { ok: false, reason: `more than ${RASTERIZE_MAX_PAGES} pages` };
    const factory = doc.canvasFactory;
    if (!factory) return { ok: false, reason: "no drawing surface on this server" };

    const out = await PDFDocument.create();
    const deadline = Date.now() + TIME_BUDGET_MS;
    const dpi = opts.color ? COLOR_DPI : GRAY_DPI;
    for (let n = 1; n <= doc.numPages; n++) {
      if (Date.now() > deadline) return { ok: false, reason: "took too long" };
      const page = await doc.getPage(n);
      try {
        const [vx0, vy0, vx1, vy1] = page.view as [number, number, number, number];
        const wPt = vx1 - vx0;
        const hPt = vy1 - vy0;
        if (!(wPt > 0 && hPt > 0)) return { ok: false, reason: "a page has no size" };
        // A rotated page is drawn as the viewer shows it, so swap the page size to match.
        const rotated = page.rotate % 180 !== 0;
        const pageW = rotated ? hPt : wPt;
        const pageH = rotated ? wPt : hPt;
        const scale = Math.min(dpi / 72, Math.sqrt(MAX_PIXELS / (pageW * pageH)));
        const viewport = page.getViewport({ scale });
        const pxW = Math.max(1, Math.ceil(viewport.width));
        const pxH = Math.max(1, Math.ceil(viewport.height));
        const target = factory.create(pxW, pxH);
        try {
          await page.render({ canvasContext: target.context, canvas: target.canvas, viewport, background: "rgb(255,255,255)" }).promise;
          const { data } = target.context.getImageData(0, 0, pxW, pxH);
          const packed = packPixels(data, pxW * pxH, opts.color);
          const stream = PDFRawStream.of(
            out.context.obj({
              Type: "XObject",
              Subtype: "Image",
              Width: pxW,
              Height: pxH,
              ColorSpace: opts.color ? "DeviceRGB" : "DeviceGray",
              BitsPerComponent: 8,
              Filter: "FlateDecode",
            }),
            deflateSync(packed, { level: 6 }),
          );
          const ref = out.context.register(stream);
          const pdfPage = out.addPage([pageW, pageH]);
          const name = pdfPage.node.newXObject("Im", ref);
          pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(pageW, 0, 0, pageH, 0, 0), drawObject(name), popGraphicsState());
        } finally {
          try {
            factory.destroy(target);
          } catch {
            /* nothing to free */
          }
        }
      } finally {
        page.cleanup();
      }
    }
    return { ok: true, bytes: await out.save(), pages: out.getPageCount() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "could not draw the pages" };
  } finally {
    try {
      await doc?.destroy();
    } catch {
      /* nothing to clean up */
    }
  }
}
