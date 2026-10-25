import "server-only";
import type { Box, PageContent } from "./crop";

/**
 * Finds where each page of a PDF actually has ink (text, images, vector graphics), ignoring its blank margins.
 * Used to crop booklet pages so the content, not the page's own margins, fills the cell (lib/pdf/crop.ts).
 *
 * Runs pdfjs-dist's legacy build in plain Node (no canvas, no native code). Text boxes come from getTextContent;
 * images and paths from the operator list, tracking the current transform. Deliberately conservative: the result
 * can only be too LARGE (so a crop never cuts content), never too small:
 *  - clipping paths are ignored (content is measured unclipped);
 *  - a shading, a repeated image or a rotated page is reported as "unknown"/full page rather than guessed;
 *  - anything that throws, or exceeds the page / time budget, yields null ("do not crop").
 * Only white filled shapes (page backgrounds, white boxes) are ignored, since they carry no ink.
 *
 * Boxes are in absolute PDF user space (the same coordinates as the page's MediaBox).
 */

const MAX_PAGES_ANALYSED = 300;
const TIME_BUDGET_MS = 12_000;

// Image-only pages (scans) are looked at as pictures: rendered small and measured, because the operator list can only
// say "one image covers the page". Everything here only ever makes the box LARGER than the true ink (never cut ink).
const RASTER_DPI = 100;
const RASTER_MAX_PIXELS = 2_500_000;
/** Pixels at or below this brightness (0-255) count as ink; light paper tint and faint grey do not. */
const INK_BRIGHTNESS_MAX = 235;
/** Added around the measured ink, on top of the crop's own safety pad (scanner edges, anti-aliasing, faint marks). */
const RASTER_PAD_PT = 8;
/** An image covering at least this share of the page makes it a scan. */
const SCAN_IMAGE_SHARE = 0.5;
/** Rendering pages is the slow part: at most this long per document; later scans stay whole (never an error). */
const RASTER_BUDGET_MS = 8_000;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The transform that applies `m` first and then `n` (PDF concatenation order). */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

class Accumulator {
  box: Box | null = null;
  addPoint(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this.box) this.box = { x0: x, y0: y, x1: x, y1: y };
    else {
      if (x < this.box.x0) this.box.x0 = x;
      if (y < this.box.y0) this.box.y0 = y;
      if (x > this.box.x1) this.box.x1 = x;
      if (y > this.box.y1) this.box.y1 = y;
    }
  }
  addRect(x0: number, y0: number, x1: number, y1: number, m: Matrix): void {
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as const) {
      this.addPoint(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
    }
  }
}

/** True for a fill colour that leaves no visible ink on white paper. */
function isWhite(hex: unknown): boolean {
  return typeof hex === "string" && /^#f{6}$/i.test(hex);
}

interface PdfjsModule {
  OPS: Record<string, number>;
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfjsDoc>; destroy?: () => Promise<void> };
  AnnotationMode?: { DISABLE: number };
}
interface PdfjsPage {
  view: number[];
  rotate: number;
  getViewport: (p: { scale: number }) => { width: number; height: number };
  render: (p: Record<string, unknown>) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str?: string; width?: number; height?: number; transform?: number[] }> }>;
  getOperatorList: (params?: Record<string, unknown>) => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  cleanup: () => void;
}
interface CanvasFactoryLike {
  create: (w: number, h: number) => { canvas: unknown; context: { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } } };
  destroy: (c: { canvas: unknown; context: unknown }) => void;
}
interface PdfjsDoc {
  canvasFactory?: CanvasFactoryLike;
  numPages: number;
  getPage: (n: number) => Promise<PdfjsPage>;
  destroy: () => Promise<void>;
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    // Importing the worker explicitly (rather than letting pdfjs `import()` it by a computed path) keeps it in the
    // server bundle's file trace, and lets pdfjs run it in-process without a Worker.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  })();
  return pdfjsPromise;
}

async function analyzePage(pdfjs: PdfjsModule, page: PdfjsPage, rasterInk?: (page: PdfjsPage) => Promise<Box | "blank" | null>): Promise<PageContent> {
  // pdf-lib (which does the imposition) does not apply /Rotate; rather than reason about both, do not crop.
  if (page.rotate % 360 !== 0) return { kind: "unknown" };
  const acc = new Accumulator();
  const OPS = pdfjs.OPS;

  // Text.
  const text = await page.getTextContent();
  for (const item of text.items) {
    if (!item.str || item.str.trim() === "" || !item.transform) continue;
    const [a, b, c, d, e, f] = item.transform as Matrix;
    const width = item.width ?? 0;
    const height = item.height ?? Math.hypot(c, d);
    const ux = Math.hypot(a, b) || 1;
    const vy = Math.hypot(c, d) || 1;
    // Unit vectors along the baseline and "up"; a little room below the baseline for descenders.
    const dx = a / ux;
    const dy = b / ux;
    const px = c / vy;
    const py = d / vy;
    const descent = 0.25 * height;
    for (const [s, t] of [
      [0, -descent],
      [width, -descent],
      [width, height],
      [0, height],
    ] as const) {
      acc.addPoint(e + dx * s + px * t, f + dy * s + py * t);
    }
  }

  // Images and vector graphics.
  const ol = await page.getOperatorList(pdfjs.AnnotationMode ? { annotationMode: pdfjs.AnnotationMode.DISABLE } : undefined);
  const paintOps = new Set<number>(
    [OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(
      (v): v is number => typeof v === "number",
    ),
  );
  const imageOps = new Set<number>(
    [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask].filter((v): v is number => typeof v === "number"),
  );
  const strokeOps = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter((v): v is number => typeof v === "number"));

  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let fillWhite = false;
  const fillStack: boolean[] = [];
  let annotationDepth = 0;
  let unknown = false;
  let lineWidth = 1;
  let biggestImageArea = 0;

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i]!;
    const args = ol.argsArray[i] as unknown[] | null;
    if (fn === OPS.beginAnnotation) annotationDepth++;
    else if (fn === OPS.endAnnotation) annotationDepth = Math.max(0, annotationDepth - 1);
    if (annotationDepth > 0) continue;

    if (fn === OPS.save) {
      stack.push(ctm);
      fillStack.push(fillWhite);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
      fillWhite = fillStack.pop() ?? fillWhite;
    } else if (fn === OPS.transform && args) {
      ctm = mul(args as unknown as Matrix, ctm);
    } else if (fn === OPS.paintFormXObjectBegin && args) {
      stack.push(ctm);
      fillStack.push(fillWhite);
      if (Array.isArray(args[0])) ctm = mul(args[0] as Matrix, ctm);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
      fillWhite = fillStack.pop() ?? fillWhite;
    } else if (fn === OPS.setLineWidth && args) {
      lineWidth = Number(args[0]) || 0;
    } else if (fn === OPS.setFillRGBColor && args) {
      fillWhite = isWhite(args[0]);
    } else if (fn === OPS.setFillGray && args) {
      fillWhite = args[0] === "#ffffff" || args[0] === 1 || args[0] === 255;
    } else if (fn === OPS.setFillColor || fn === OPS.setFillColorN || fn === OPS.setFillCMYKColor || fn === OPS.setFillColorSpace) {
      fillWhite = fn === OPS.setFillCMYKColor && isWhite(args?.[0]);
    } else if (imageOps.has(fn)) {
      acc.addRect(0, 0, 1, 1, ctm);
      biggestImageArea = Math.max(biggestImageArea, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
    } else if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObjectRepeat || fn === OPS.shadingFill || fn === OPS.paintShading) {
      unknown = true; // tiled images and shadings fill an area the operator list does not bound
    } else if (fn === OPS.constructPath && args) {
      const paintOp = args[0] as number;
      const minMax = args[2] as ArrayLike<number> | undefined;
      if (!paintOps.has(paintOp) || !minMax || minMax.length < 4) continue; // clip / endPath paint nothing
      const stroked = strokeOps.has(paintOp);
      const filled = paintOp !== OPS.stroke && paintOp !== OPS.closeStroke;
      if (filled && !stroked && fillWhite) continue; // a white box leaves no ink
      const half = stroked ? Math.max(lineWidth, 0) / 2 : 0;
      acc.addRect(minMax[0]! - half, minMax[1]! - half, minMax[2]! + half, minMax[3]! + half, ctm);
    }
  }

  if (unknown) return { kind: "unknown" };
  if (!acc.box) return { kind: "blank" };

  const pageArea = Math.abs((page.view[2]! - page.view[0]!) * (page.view[3]! - page.view[1]!));
  if (rasterInk && pageArea > 0 && biggestImageArea >= SCAN_IMAGE_SHARE * pageArea) {
    // A scan. If the picture cannot be measured the operator box stands (the whole image: nothing is cut).
    const ink = await rasterInk(page).catch(() => null);
    if (ink === "blank") return { kind: "blank" };
    if (ink) return { kind: "content", box: ink, scan: true };
  }
  return { kind: "content", box: acc.box };
}

/** Renders a page small and returns the box (PDF user space) around everything that is not near-white, or null if it could not be measured. */
async function measureInk(doc: PdfjsDoc, page: PdfjsPage): Promise<Box | "blank" | null> {
  const factory = doc.canvasFactory;
  if (!factory) return null;
  const [vx0, vy0, vx1, vy1] = page.view as [number, number, number, number];
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  if (!(w > 0 && h > 0)) return null;
  const scale = Math.min(RASTER_DPI / 72, Math.sqrt(RASTER_MAX_PIXELS / (w * h)));
  const viewport = page.getViewport({ scale });
  const pxW = Math.max(1, Math.ceil(viewport.width));
  const pxH = Math.max(1, Math.ceil(viewport.height));
  const target = factory.create(pxW, pxH);
  try {
    await page.render({ canvasContext: target.context, canvas: target.canvas, viewport, background: "rgb(255,255,255)" }).promise;
    const { data } = target.context.getImageData(0, 0, pxW, pxH);
    let minX = pxW;
    let maxX = -1;
    let minY = pxH;
    let maxY = -1;
    for (let y = 0; y < pxH; y++) {
      const row = y * pxW * 4;
      for (let x = 0; x < pxW; x++) {
        const i = row + x * 4;
        const a = data[i + 3]! / 255;
        // Composite on white, then take the brightest-channel-agnostic luminance.
        const lum = 0.299 * (data[i]! * a + 255 * (1 - a)) + 0.587 * (data[i + 1]! * a + 255 * (1 - a)) + 0.114 * (data[i + 2]! * a + 255 * (1 - a));
        if (lum <= INK_BRIGHTNESS_MAX) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return "blank";
    const pad = RASTER_PAD_PT;
    return {
      x0: Math.max(vx0, vx0 + minX / scale - pad),
      x1: Math.min(vx1, vx0 + (maxX + 1) / scale + pad),
      y0: Math.max(vy0, vy1 - (maxY + 1) / scale - pad),
      y1: Math.min(vy1, vy1 - minY / scale + pad),
    };
  } finally {
    try {
      factory.destroy(target);
    } catch {
      /* nothing to free */
    }
  }
}

/**
 * One entry per page (in page order): its ink box, "blank", or "unknown" (analysis not possible for that page).
 * Returns null if the document cannot be opened or analysis fails or runs out of budget; callers then do not crop.
 */
export async function analyzePdfContent(bytes: Uint8Array): Promise<PageContent[] | null> {
  let doc: PdfjsDoc | null = null;
  try {
    const pdfjs = await loadPdfjs();
    // pdfjs takes ownership of (transfers) the buffer it is given, so hand it a copy.
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: false,
    });
    doc = await task.promise;
    if (doc.numPages > MAX_PAGES_ANALYSED) return null;
    const deadline = Date.now() + TIME_BUDGET_MS;
    const rasterDeadline = Date.now() + RASTER_BUDGET_MS;
    const currentDoc = doc;
    const rasterInk = async (p: PdfjsPage): Promise<Box | "blank" | null> => (Date.now() > rasterDeadline ? null : measureInk(currentDoc, p));
    const out: PageContent[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (Date.now() > deadline) return null;
      const page = await doc.getPage(n);
      try {
        out.push(await analyzePage(pdfjs, page, rasterInk));
      } catch {
        out.push({ kind: "unknown" });
      } finally {
        page.cleanup();
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    try {
      await doc?.destroy();
    } catch {
      /* nothing to clean up */
    }
  }
}
