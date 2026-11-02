import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import { EZRA_SIL_REGULAR_BASE64 } from "@/lib/booklet/fonts/ezra-sil-regular";
import { drawableRuns, embedFonts, type Fonts } from "@/lib/booklet/frontmatter";
import type { Direction } from "@/lib/booklet/bidi";
import type { StudySection } from "./page";

/**
 * "Fill the page": builds a PDF straight from the study text so the booklet's pages are FULL, instead of shrinking a finished
 * document into a corner of the sheet. The page is the booklet's own page size (for a Letter booklet, half a Letter sheet) with
 * small margins; the font size is then chosen to use all of it:
 *   1. find how many pages the text needs at the smallest readable size and round that up to a multiple of 4 (a booklet sheet
 *      holds 4 pages), the fewest sheets that keep the text readable;
 *   2. take the largest font size (up to a limit) that still fits in that many pages;
 *   3. open the line spacing a little to use whatever is left of the last page.
 * Layout follows the Chitas & Rambam builder the owner likes: with both languages, Hebrew on the left and English on the right,
 * side by side, row by row (verse number between them), and Rashi in a lightly shaded box. One language alone uses the full width.
 * Text is only drawn, never changed: Hebrew is set in Ezra SIL, which has every vowel and cantillation mark; English in David Libre.
 * See docs/daily-study.md.
 */

export type Language = "he" | "en" | "both";

/** The three bundled fonts: English regular and bold (David Libre), and Hebrew (Ezra SIL). */
interface LayoutFonts extends Fonts {
  hebrew: PDFFont;
}
const fontName = (f: LayoutFonts, font: PDFFont): DrawOp["font"] => (font === f.hebrew ? "hebrew" : font === f.bold ? "bold" : "regular");

export interface FillItem {
  title: string;
  sections: StudySection[];
}

export interface FillInput {
  /** The booklet's title, at the top of the first page. */
  title: string;
  items: FillItem[];
  language: Language;
  /** One booklet page, in points (half-letter: 396 x 612). */
  page: { width: number; height: number };
  /** All four margins, in points. */
  margin: number;
  minSize?: number;
  maxSize?: number;
  /** A line at the very end, e.g. the thank-you to the source. */
  credit?: string;
}

export interface DrawOp {
  /** The line, in logical (reading) order. */
  logical: string;
  /** Left edge of the line's drawn width. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  size: number;
  bold: boolean;
  /** Which bundled font draws it: Hebrew paragraphs use "hebrew". */
  font: "regular" | "bold" | "hebrew";
  dir: Direction;
  role: "heading" | "body" | "credit" | "number";
}

/** A lightly shaded box behind Rashi. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FillPlan {
  size: number;
  pages: DrawOp[][];
  rects: Rect[][];
}

export interface FillResult {
  bytes: Uint8Array;
  pages: number;
  targetPages: number;
  fontSize: number;
  pagesAtMinSize: number;
  /** How much of the last page's text area is used, 0 to 1 (before any blank pages added to reach a multiple of 4). */
  lastPageFill: number;
  /** True only if some marks had to be left out (none today: the Hebrew font has them all). */
  strippedMarks: boolean;
  plan: FillPlan;
}

const MIN_SIZE = 10.5;
const MAX_SIZE = 14;
const STEP = 0.1;
const LINE = 1.28;
/** The line spacing may open up to this to use leftover room on the last page, never more (it would look loose). */
const LINE_MAX = 1.5;
const LINE_STEP = 0.01;
const INK = rgb(0.07, 0.07, 0.09);
const SHADE = rgb(0.94, 0.93, 0.91);
/** Space between the Hebrew and English columns; the verse number sits in it. */
const GUTTER = 16;
const BOX_PAD = 4;

interface Para {
  text: string;
  kind: "regular" | "bold" | "hebrew";
  dir: Direction;
  scale: number;
  /** Space above it, in font sizes (inside a column, between its paragraphs). */
  before: number;
  role: DrawOp["role"];
}

interface Row {
  /** Hebrew side, English side. A single-language or full-width row uses only `left`. */
  left: Para[];
  right: Para[];
  /** One column across the whole width. */
  full: boolean;
  center?: boolean;
  keepWithNext?: boolean;
  /** Space above the row, in font sizes. */
  before: number;
  num?: string;
  shade?: boolean;
}

const heading = (text: string, scale: number, before: number, center = false): Row => ({
  left: [{ text, kind: "bold", dir: "ltr", scale, before: 0, role: "heading" }],
  right: [],
  full: true,
  center,
  keepWithNext: true,
  before,
});

function rows(input: FillInput): Row[] {
  const out: Row[] = [heading(input.title, 1.3, 0, true)];
  const both = input.language === "both";
  const he = (text: string, scale: number, before = 0): Para => ({ text, kind: "hebrew", dir: "rtl", scale, before, role: "body" });
  // English is set in David Libre, which has the letters and vowel marks but no cantillation marks: leave those out of Hebrew words quoted inside English.
  const en = (text: string, scale: number, before = 0, bold = false): Para => ({ text: text.replace(/[֑-ֽ֯]/g, ""), kind: bold ? "bold" : "regular", dir: "ltr", scale, before, role: "body" });

  for (const item of input.items) {
    out.push(heading(item.title, 1.12, 0.9));
    for (const section of item.sections) {
      if (section.heading && section.heading !== item.title) out.push(heading(section.heading, 1.02, 0.6));
      for (const b of section.blocks) {
        const rashi = b.kind === "rashi";
        const scale = rashi || b.kind === "note" ? 0.9 : 1;
        const hePart: Para[] = [];
        const enPart: Para[] = [];
        if (rashi && b.leadHe) hePart.push(he(b.leadHe, scale));
        if (b.he) hePart.push(he(b.he, scale, rashi && b.leadHe ? 0.15 : 0));
        if (rashi && b.leadEn) enPart.push(en(b.leadEn, scale, 0, true));
        if (b.en) enPart.push(en(b.en, scale, rashi && b.leadEn ? 0.15 : 0));
        const base = { before: rashi ? 0.5 : 0.55, ...(rashi ? { shade: true } : {}) };
        if (both) {
          if (hePart.length === 0 && enPart.length === 0) continue;
          out.push({ left: hePart, right: enPart, full: false, num: b.kind === "verse" ? b.num : undefined, ...base });
        } else {
          const only = input.language === "he" ? hePart : enPart;
          if (only.length > 0) out.push({ left: only, right: [], full: true, ...base });
        }
      }
    }
  }
  if (input.credit) {
    out.push({ left: [{ text: input.credit, kind: "regular", dir: "ltr", scale: 0.75, before: 0, role: "credit" }], right: [], full: true, center: true, before: 1.2 });
  }
  return out;
}

/** Measures each word once per font (text width is exactly proportional to the font size): measuring is the slow part of laying out many pages. */
function measurer(fonts: LayoutFonts) {
  const cache = new Map<string, number>();
  return (font: PDFFont, size: number, text: string): number => {
    const key = `${fontName(fonts, font)}|${text}`;
    let unit = cache.get(key);
    if (unit === undefined) {
      unit = font.widthOfTextAtSize(text, 1000);
      cache.set(key, unit);
    }
    return (unit * size) / 1000;
  };
}
type Measure = ReturnType<typeof measurer>;

/** Breaks text into lines that fit `maxWidth`; a word wider than a line is cut by letters rather than overflowing. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number, measure: Measure): { text: string; width: number }[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const space = measure(font, size, " ");
  const lines: { text: string; width: number }[] = [];
  let line = "";
  let lineW = 0;
  for (const word of words) {
    let w = measure(font, size, word);
    if (line && lineW + space + w <= maxWidth) {
      line += " " + word;
      lineW += space + w;
      continue;
    }
    if (line) lines.push({ text: line, width: lineW });
    let rest = word;
    while (w > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(font, size, rest.slice(0, cut)) > maxWidth) cut--;
      lines.push({ text: rest.slice(0, cut), width: measure(font, size, rest.slice(0, cut)) });
      rest = rest.slice(cut);
      w = measure(font, size, rest);
    }
    line = rest;
    lineW = w;
  }
  if (line) lines.push({ text: line, width: lineW });
  return lines;
}

/** One laid-out line of a column, waiting to be placed on a page. */
interface ColLine {
  text: string;
  width: number;
  size: number;
  font: PDFFont;
  dir: Direction;
  role: DrawOp["role"];
  /** Height it takes, including any space above it. */
  h: number;
  /** Line height alone (the part below the space above). */
  lh: number;
}

function column(paras: Para[], fonts: LayoutFonts, size: number, width: number, line: number, measure: Measure): ColLine[] {
  const out: ColLine[] = [];
  paras.forEach((p, pi) => {
    const sz = size * p.scale;
    const font = p.kind === "hebrew" ? fonts.hebrew : p.kind === "bold" ? fonts.bold : fonts.regular;
    const lh = sz * line;
    wrap(p.text, font, sz, width, measure).forEach((l, li) => {
      out.push({ text: l.text, width: l.width, size: sz, font, dir: p.dir, role: p.role, lh, h: lh + (li === 0 && pi > 0 ? p.before * size : 0) });
    });
  });
  return out;
}

function layout(input: FillInput, fonts: LayoutFonts, size: number, measure: Measure, line = LINE): FillPlan {
  const { width, height } = input.page;
  const m = input.margin;
  const left = m;
  const right = width - m;
  const top = height - m;
  const bottom = m;
  const pages: DrawOp[][] = [[]];
  const rects: Rect[][] = [[]];
  let y = top;
  let first = true;
  const newPage = () => {
    pages.push([]);
    rects.push([]);
    y = top;
  };
  const emit = (op: DrawOp) => pages[pages.length - 1]!.push(op);

  for (const row of rows(input)) {
    const pad = row.shade ? BOX_PAD : 0;
    const inner = right - left - 2 * pad;
    const colW = row.full ? inner : (inner - GUTTER) / 2;
    const hebrewX = left + pad; // left column
    const englishX = left + pad + colW + GUTTER; // right column
    const L = column(row.left, fonts, size, colW, line, measure);
    const R = row.full ? [] : column(row.right, fonts, size, colW, line, measure);
    if (L.length === 0 && R.length === 0) continue;

    const sum = (c: ColLine[]) => c.reduce((s, l) => s + l.h, 0);
    const gap = first ? 0 : row.before * size;
    const total = Math.max(sum(L), sum(R)) + 2 * pad;
    // Keep a row together when it would fit a page on its own; a heading also stays with the first lines after it.
    const pageH = top - bottom;
    const need = (row.keepWithNext ? total + 2 * size * line : total) + gap;
    if (!first && y - need < bottom - size * line * 0.25 && total <= pageH * 0.6) newPage();
    else if (!first) y -= gap;
    first = false;

    let li = 0;
    let ri = 0;
    let startOfRow = true;
    while (li < L.length || ri < R.length) {
      // Take lines from each column until this page is full (at least one line, so a tall line never loops forever).
      const room = y - bottom + size * line * 0.25 - 2 * pad;
      const take = (c: ColLine[], from: number) => {
        let used = 0;
        let n = 0;
        while (from + n < c.length) {
          const h = startOfRow && n === 0 ? c[from]!.lh : c[from + n]!.h;
          if (used + h > room && (n > 0 || y < top)) break;
          used += h;
          n++;
        }
        return { n, used };
      };
      const a = take(L, li);
      const b = take(R, ri);
      if (a.n === 0 && b.n === 0) {
        newPage();
        continue;
      }
      const used = Math.max(a.used, b.used);
      const boxTop = y;
      let cy = y - pad;
      const place = (c: ColLine[], from: number, n: number, x0: number, x1: number, rtlSide: boolean) => {
        let yy = cy;
        for (let k = from; k < from + n; k++) {
          const l = c[k]!;
          const h = startOfRow && k === from ? l.lh : l.h;
          yy -= h;
          const x = row.center ? (left + right - l.width) / 2 : l.dir === "rtl" || rtlSide ? x1 - l.width : x0;
          emit({ logical: l.text, x, y: yy + l.lh * 0.22, width: l.width, size: l.size, bold: l.font === fonts.bold, font: fontName(fonts, l.font), dir: l.dir, role: l.role });
        }
      };
      if (row.full) place(L, li, a.n, hebrewX, hebrewX + colW, false);
      else {
        place(L, li, a.n, hebrewX, hebrewX + colW, true);
        place(R, ri, b.n, englishX, englishX + colW, false);
        if (row.num && startOfRow) {
          const numSize = size * 0.8;
          const nw = measure(fonts.hebrew, numSize, row.num);
          emit({ logical: row.num, x: hebrewX + colW + (GUTTER - nw) / 2, y: cy - L[0]!.lh + L[0]!.lh * 0.22, width: nw, size: numSize, bold: false, font: "hebrew", dir: "rtl", role: "number" });
        }
      }
      if (row.shade) rects[rects.length - 1]!.push({ x: left, y: boxTop - used - 2 * pad, width: right - left, height: used + 2 * pad });
      y = boxTop - used - 2 * pad;
      li += a.n;
      ri += b.n;
      startOfRow = false;
      if (li < L.length || ri < R.length) newPage();
    }
  }
  return { size, pages, rects };
}

function usedFraction(input: FillInput, plan: FillPlan): number {
  const last = plan.pages[plan.pages.length - 1] ?? [];
  if (last.length === 0) return 0;
  const m = input.margin;
  const lowest = Math.min(...last.map((o) => o.y));
  return Math.max(0, Math.min(1, (input.page.height - m - (lowest - m)) / (input.page.height - 2 * m)));
}

export async function buildFilledPdf(input: FillInput): Promise<FillResult> {
  const doc = await PDFDocument.create();
  const base = await embedFonts(doc);
  const fonts: LayoutFonts = { ...base, hebrew: await doc.embedFont(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64"), { subset: true }) };
  const minSize = input.minSize ?? MIN_SIZE;
  const maxSize = input.maxSize ?? MAX_SIZE;

  const measure = measurer(fonts);
  const atMin = layout(input, fonts, minSize, measure);
  const pagesAtMinSize = atMin.pages.length;
  const targetPages = Math.max(4, Math.ceil(pagesAtMinSize / 4) * 4);

  // Page count only grows with the font size, so a binary search over the sizes finds the largest one that still fits.
  const steps = Math.max(0, Math.floor((maxSize - minSize) / STEP + 1e-9));
  let plan = atMin;
  let lo = 0;
  let hi = steps;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const trial = layout(input, fonts, minSize + mid * STEP, measure);
    if (trial.pages.length <= targetPages) {
      plan = trial;
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // Page count only grows with the line spacing too, so open it up as far as the chosen page count allows.
  const lineSteps = Math.floor((LINE_MAX - LINE) / LINE_STEP + 1e-9);
  let llo = 0;
  let lhi = lineSteps;
  while (llo < lhi) {
    const mid = Math.ceil((llo + lhi) / 2);
    const trial = layout(input, fonts, plan.size, measure, LINE + mid * LINE_STEP);
    if (trial.pages.length <= targetPages) {
      plan = trial;
      llo = mid;
    } else {
      lhi = mid - 1;
    }
  }

  const lastPageFill = usedFraction(input, plan);
  while (plan.pages.length < targetPages) {
    plan.pages.push([]);
    plan.rects.push([]);
  }

  plan.pages.forEach((ops, pi) => {
    const page = doc.addPage([input.page.width, input.page.height]);
    for (const r of plan.rects[pi] ?? []) page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: SHADE });
    for (const op of ops) {
      const font = fonts[op.font];
      let x = op.x;
      const runs = drawableRuns(op.logical, op.dir);
      for (const r of runs) {
        page.drawText(r.draw, { x, y: op.y, size: op.size, font, color: INK });
        // Only a line made of several pieces needs each piece measured; the usual single piece does not.
        if (runs.length > 1) x += font.widthOfTextAtSize(r.draw, op.size);
      }
    }
  });
  const bytes = await doc.save();
  return { bytes, pages: plan.pages.length, targetPages, fontSize: plan.size, pagesAtMinSize, lastPageFill, strippedMarks: false, plan };
}
