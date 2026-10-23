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
  getTextContent: () => Promise<{ items: Array<{ str?: string; width?: number; height?: number; transform?: number[] }> }>;
  getOperatorList: (params?: Record<string, unknown>) => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  cleanup: () => void;
}
interface PdfjsDoc {
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

async function analyzePage(pdfjs: PdfjsModule, page: PdfjsPage): Promise<PageContent> {
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
  return acc.box ? { kind: "content", box: acc.box } : { kind: "blank" };
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
    const out: PageContent[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (Date.now() > deadline) return null;
      const page = await doc.getPage(n);
      try {
        out.push(await analyzePage(pdfjs, page));
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
