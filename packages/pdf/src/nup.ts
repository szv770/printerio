import { PDFDocument, degrees, rgb, type PDFEmbeddedPage } from "pdf-lib";
import { computeCroppedSlotTransform } from "./crop";
import { IMPOSITION_MARGIN_PT, resolvePaperSizePoints } from "./imposition";

/**
 * The layout engine: several pages on one sheet ("n-up") and the same page repeated on a sheet ("step and repeat").
 * Runs on the print server inside `preparePdf`, after the page range, in place of the booklet step.
 *
 * The geometry is planned by pure functions (`planSheet`, `chooseOrientation`, `layoutSheetGroups`) so tests can check cells, margins
 * and cut marks without opening a PDF; `buildLayoutPdf` draws the plan with pdf-lib, reusing `embedPages` like the booklet code.
 * A source page is only ever shrunk to fit its cell (never enlarged), aspect ratio kept, centred.
 */

export type LayoutSpec =
  | {
      kind: "nup";
      cols: number;
      rows: number;
      /** Space between neighbouring pages, in points (default 8). */
      gap?: number;
      /** Space around the whole grid, in points; never below 14 (printers cannot print to the edge). */
      margin?: number;
      /** A thin line around each page. */
      border?: boolean;
      /** "row" (default): left to right, then down. "column": top to bottom, then right. */
      order?: "row" | "column";
      /** "auto" (default) picks whichever sheet direction makes the pages larger. */
      orientation?: "auto" | "portrait" | "landscape";
    }
  | {
      kind: "repeat";
      cols: number;
      rows: number;
      /** "each": every page gets its own sheet(s) of copies; "first": only page 1; a number: only that page (1-based, after the page range). */
      pages: "each" | "first" | number;
      /** Small corner ticks in the gutter, for cutting the sheet apart. */
      marks?: boolean;
      border?: boolean;
      /** Space between copies in points (default 14; at least 14 when marks are on). */
      gap?: number;
    };

export const LAYOUT_MIN_MARGIN_PT = IMPOSITION_MARGIN_PT;
export const NUP_DEFAULT_GAP_PT = 8;
export const REPEAT_DEFAULT_GAP_PT = 14;
export const REPEAT_MIN_GAP_WITH_MARKS_PT = 14;
export const NUP_MAX_PER_SHEET = 36;
export const REPEAT_MIN_COPIES = 2;
export const REPEAT_MAX_COPIES = 12;
const MAX_GAP_PT = 100;
const MAX_MARGIN_PT = 150;
const MIN_CELL_PT = 24;
const MARK_OFFSET_PT = 2;
const MARK_MAX_LEN_PT = 8;

/** The simple "pages per sheet" choices: grid for 1, 2, 4, 6 and 9 per sheet. */
export const NUP_PRESETS: Record<1 | 2 | 4 | 6 | 9, { cols: number; rows: number }> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  4: { cols: 2, rows: 2 },
  6: { cols: 3, rows: 2 },
  9: { cols: 3, rows: 3 },
};

export class LayoutError extends Error {}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** A plain message when the request makes no sense, else null. `sourcePages` (when known) also checks a chosen page of a repeat. */
export function validateLayout(layout: LayoutSpec, sourcePages?: number): string | null {
  if (!layout || (layout.kind !== "nup" && layout.kind !== "repeat")) return "That page layout isn't one Printio knows.";
  if (!isInt(layout.cols) || !isInt(layout.rows) || layout.cols < 1 || layout.rows < 1 || layout.cols > 12 || layout.rows > 12) {
    return "Choose a whole number of columns and rows (1 to 12).";
  }
  const per = layout.cols * layout.rows;
  for (const [name, v, max] of [["gap", layout.gap, MAX_GAP_PT], ...(layout.kind === "nup" ? ([["margin", layout.margin, MAX_MARGIN_PT]] as const) : [])] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)) return `The ${name} must be between 0 and ${max} points.`;
  }
  if (layout.kind === "nup") {
    if (per > NUP_MAX_PER_SHEET) return `Pages per sheet can be at most ${NUP_MAX_PER_SHEET}.`;
    return null;
  }
  if (per < REPEAT_MIN_COPIES || per > REPEAT_MAX_COPIES) return `Copies per sheet must be between ${REPEAT_MIN_COPIES} and ${REPEAT_MAX_COPIES}.`;
  const p = layout.pages;
  if (p !== "each" && p !== "first" && !isInt(p)) return "Choose which page to repeat.";
  if (isInt(p) && (p < 1 || (sourcePages !== undefined && p > sourcePages))) return `Page ${p} to repeat isn't in this document${sourcePages ? ` (it has ${sourcePages} pages)` : ""}.`;
  return null;
}

/** For each output sheet side, the 1-based source pages (after the page range) it holds, in drawing order. Repeats list a page once per copy. */
export function layoutSheetGroups(layout: LayoutSpec, sourcePages: number): number[][] {
  const per = layout.cols * layout.rows;
  if (layout.kind === "nup") {
    const groups: number[][] = [];
    for (let start = 1; start <= sourcePages; start += per) {
      groups.push(Array.from({ length: Math.min(per, sourcePages - start + 1) }, (_, i) => start + i));
    }
    return groups;
  }
  const chosen = layout.pages === "each" ? Array.from({ length: sourcePages }, (_, i) => i + 1) : [layout.pages === "first" ? 1 : layout.pages];
  return chosen.map((p) => Array.from({ length: per }, () => p));
}

/** How many physical pages (sides) the layout produces: what print math, quota and cost count. */
export function layoutSheetCount(layout: LayoutSpec, sourcePages: number): number {
  return layoutSheetGroups(layout, sourcePages).length;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Placement {
  /** 0-based index into the sheet's page list. */
  index: number;
  cell: Rect;
  /** Where the (scaled) page lands. */
  rect: Rect;
  scale: number;
}
export interface SheetPlan {
  width: number;
  height: number;
  placements: Placement[];
  marks: Segment[];
  borders: Rect[];
}

export interface PlanOptions {
  cols: number;
  rows: number;
  gap: number;
  margin: number;
  order: "row" | "column";
  border: boolean;
  marks: boolean;
}

/** Cell number (0 = top-left) of the i-th page of a sheet: row-major or column-major. */
export function cellOf(i: number, cols: number, rows: number, order: "row" | "column"): { col: number; row: number } {
  return order === "row" ? { col: i % cols, row: Math.floor(i / cols) } : { col: Math.floor(i / rows), row: i % rows };
}

export function marksLength(gap: number): number {
  return Math.max(0, Math.min(MARK_MAX_LEN_PT, gap / 2 - MARK_OFFSET_PT - 1));
}

/**
 * Plans one sheet. `pages` are the DISPLAYED sizes (points) of the pages in cell order (row- or column-major as `order` says); a sheet may hold
 * fewer pages than cells (the last sheet of an n-up). Throws LayoutError when the cells would be uselessly small.
 */
export function planSheet(width: number, height: number, pages: Array<{ width: number; height: number }>, o: PlanOptions): SheetPlan {
  const margin = Math.max(o.margin, LAYOUT_MIN_MARGIN_PT);
  const gap = o.marks ? Math.max(o.gap, REPEAT_MIN_GAP_WITH_MARKS_PT) : o.gap;
  const cellW = (width - 2 * margin - (o.cols - 1) * gap) / o.cols;
  const cellH = (height - 2 * margin - (o.rows - 1) * gap) / o.rows;
  if (cellW < MIN_CELL_PT || cellH < MIN_CELL_PT) throw new LayoutError("That many pages don't fit on one sheet with these spacings. Use fewer per sheet or a smaller gap.");
  const placements: Placement[] = [];
  const marks: Segment[] = [];
  const borders: Rect[] = [];
  const len = marksLength(gap);
  pages.forEach((page, index) => {
    const { col, row } = cellOf(index, o.cols, o.rows, o.order);
    const cell: Rect = { x: margin + col * (cellW + gap), y: height - margin - (row + 1) * cellH - row * gap, width: cellW, height: cellH };
    const t = computeCroppedSlotTransform(page, cell, 1);
    const rect: Rect = { x: t.x, y: t.y, width: page.width * t.scale, height: page.height * t.scale };
    placements.push({ index, cell, rect, scale: t.scale });
    if (o.border) borders.push(rect);
    if (o.marks && len > 0) {
      const { x, y, width: w, height: h } = rect;
      const a = MARK_OFFSET_PT;
      for (const [cx, dx] of [[x, -1], [x + w, 1]] as const) {
        for (const [cy, dy] of [[y, -1], [y + h, 1]] as const) {
          marks.push({ x1: cx + dx * a, y1: cy, x2: cx + dx * (a + len), y2: cy });
          marks.push({ x1: cx, y1: cy + dy * a, x2: cx, y2: cy + dy * (a + len) });
        }
      }
    }
  });
  return { width, height, placements, marks, borders };
}

/** Portrait/landscape for a sheet: "auto" takes the one that lets the page be larger (a tie stays portrait). `paper` is any orientation. */
export function chooseOrientation(
  paper: { width: number; height: number },
  page: { width: number; height: number },
  o: { cols: number; rows: number; gap: number; margin: number },
  want: "auto" | "portrait" | "landscape" = "auto",
): { width: number; height: number; landscape: boolean } {
  const short = Math.min(paper.width, paper.height);
  const long = Math.max(paper.width, paper.height);
  const portrait = { width: short, height: long, landscape: false };
  const landscape = { width: long, height: short, landscape: true };
  if (want === "portrait") return portrait;
  if (want === "landscape") return landscape;
  const margin = Math.max(o.margin, LAYOUT_MIN_MARGIN_PT);
  const scaleOn = (s: { width: number; height: number }) => {
    const cw = (s.width - 2 * margin - (o.cols - 1) * o.gap) / o.cols;
    const ch = (s.height - 2 * margin - (o.rows - 1) * o.gap) / o.rows;
    return Math.min(cw / page.width, ch / page.height, 1);
  };
  return scaleOn(landscape) > scaleOn(portrait) + 1e-9 ? landscape : portrait;
}

function drawPlan(out: PDFDocument, plan: SheetPlan, embedded: Array<{ page: PDFEmbeddedPage; rotation: number }>): void {
  const sheet = out.addPage([plan.width, plan.height]);
  for (const p of plan.placements) {
    const { page: e, rotation } = embedded[p.index]!;
    const s = p.scale;
    const { x, y } = p.rect;
    // /Rotate is clockwise on screen; drawPage rotates counter-clockwise, so turn by -rotation and shift the turned page back onto its rect.
    const at = rotation === 90 ? { x, y: y + e.width * s } : rotation === 180 ? { x: x + e.width * s, y: y + e.height * s } : rotation === 270 ? { x: x + e.height * s, y } : { x, y };
    sheet.drawPage(e, { x: at.x, y: at.y, xScale: s, yScale: s, ...(rotation ? { rotate: degrees(-rotation) } : {}) });
  }
  for (const b of plan.borders) sheet.drawRectangle({ x: b.x, y: b.y, width: b.width, height: b.height, borderWidth: 0.5, borderColor: rgb(0.45, 0.45, 0.45) });
  for (const m of plan.marks) sheet.drawLine({ start: { x: m.x1, y: m.y1 }, end: { x: m.x2, y: m.y2 }, thickness: 0.5, color: rgb(0, 0, 0) });
}

export interface LayoutBuild {
  bytes: Uint8Array;
  /** Physical pages (sides) in the output. */
  sheets: number;
}

/** Lays the document out. `paperSize` is the job's paper size ("letter", "a4", "11x17" ...). Throws LayoutError with a plain message for a bad request. */
export async function buildLayoutPdf(sourceBytes: Uint8Array, layout: LayoutSpec, paperSize: string): Promise<LayoutBuild> {
  const source = await PDFDocument.load(sourceBytes);
  const total = source.getPageCount();
  const bad = validateLayout(layout, total);
  if (bad) throw new LayoutError(bad);
  // A page with no drawing operations has no Contents stream, which pdf-lib refuses to embed (same fix as the booklet code).
  for (const p of source.getPages()) p.pushOperators();
  const out = await PDFDocument.create();
  const embeddedAll = await out.embedPages(source.getPages());
  const info = source.getPages().map((p, i) => {
    const rotation = ((p.getRotation().angle % 360) + 360) % 360;
    const e = embeddedAll[i]!;
    const swap = rotation === 90 || rotation === 270;
    return { page: e, rotation, size: swap ? { width: e.height, height: e.width } : { width: e.width, height: e.height } };
  });
  const paper = resolvePaperSizePoints(paperSize);
  const groups = layoutSheetGroups(layout, total);
  const gap = layout.gap ?? (layout.kind === "nup" ? NUP_DEFAULT_GAP_PT : REPEAT_DEFAULT_GAP_PT);
  const margin = layout.kind === "nup" ? layout.margin ?? LAYOUT_MIN_MARGIN_PT : LAYOUT_MIN_MARGIN_PT;
  const order = layout.kind === "nup" ? layout.order ?? "row" : "row";
  const want = layout.kind === "nup" ? layout.orientation ?? "auto" : "auto";
  const marks = layout.kind === "repeat" && layout.marks === true;
  const grid = { cols: layout.cols, rows: layout.rows, gap: marks ? Math.max(gap, REPEAT_MIN_GAP_WITH_MARKS_PT) : gap, margin };
  // One sheet direction for a whole n-up (decided by its first page); a repeat decides per sheet from the page it repeats.
  const nupSheet = layout.kind === "nup" ? chooseOrientation(paper, info[0]!.size, grid, want) : null;

  for (const group of groups) {
    const sheet = nupSheet ?? chooseOrientation(paper, info[group[0]! - 1]!.size, grid, want);
    const plan = planSheet(sheet.width, sheet.height, group.map((p) => info[p - 1]!.size), { ...grid, order, border: layout.border === true, marks });
    drawPlan(out, plan, group.map((p) => info[p - 1]!));
  }
  return { bytes: await out.save(), sheets: groups.length };
}
