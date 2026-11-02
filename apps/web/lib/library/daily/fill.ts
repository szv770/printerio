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
 *   2. take the largest font size (up to a limit) that still fits in that many pages.
 * So no sheet is wasted and the last page is well used. Text is only drawn, never changed: Hebrew is set in Ezra SIL, which has every
 * vowel and cantillation mark; English in David Libre.
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
  role: "heading" | "body" | "credit";
}

export interface FillPlan {
  size: number;
  pages: DrawOp[][];
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

interface Para {
  text: string;
  dir: Direction;
  bold: boolean;
  scale: number;
  before: number;
  role: DrawOp["role"];
  center?: boolean;
  keepWithNext?: boolean;
  /** Inset from the start edge, in points: sets commentary apart from the text it explains. */
  indent?: number;
}

function paragraphs(input: FillInput): Para[] {
  const out: Para[] = [];
  out.push({ text: input.title, dir: "ltr", bold: true, scale: 1.3, before: 0, role: "heading", center: true, keepWithNext: true });
  for (const item of input.items) {
    out.push({ text: item.title, dir: "ltr", bold: true, scale: 1.12, before: 0.8, role: "heading", keepWithNext: true });
    for (const section of item.sections) {
      if (section.heading && section.heading !== item.title) out.push({ text: section.heading, dir: "ltr", bold: true, scale: 1.02, before: 0.6, role: "heading", keepWithNext: true });
      for (const b of section.blocks) {
        const rashi = b.kind === "rashi";
        const scale = rashi || b.kind === "note" ? 0.88 : 1;
        const indent = rashi || b.kind === "note" ? 9 : 0;
        const lead = (l?: string) => (rashi && l ? (/[.:!?]$/.test(l.trim()) ? `${l.trim()} ` : `${l.trim()}: `) : "");
        if (input.language !== "en" && b.he) out.push({ text: `${lead(b.leadHe)}${b.he}`, dir: "rtl", bold: false, scale, before: rashi ? 0.15 : 0.45, role: "body", indent });
        if (input.language !== "he" && b.en) {
          const num = b.kind === "verse" && b.num ? `${b.num}. ` : "";
          out.push({ text: `${num}${lead(b.leadEn)}${b.en}`, dir: "ltr", bold: false, scale, before: input.language === "both" ? 0.1 : rashi ? 0.15 : 0.45, role: "body", indent });
        }
      }
    }
  }
  if (input.credit) out.push({ text: input.credit, dir: "ltr", bold: false, scale: 0.75, before: 1.2, role: "credit", center: true });
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

function layout(input: FillInput, fonts: LayoutFonts, size: number, measure: Measure, line = LINE): FillPlan {
  const { width, height } = input.page;
  const m = input.margin;
  const left = m;
  const right = width - m;
  const top = height - m;
  const bottom = m;
  const pages: DrawOp[][] = [[]];
  let y = top;
  let first = true;

  const paras = paragraphs(input);
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!;
    const sz = size * p.scale;
    const font: PDFFont = p.dir === "rtl" ? fonts.hebrew : p.bold ? fonts.bold : fonts.regular;
    const ind = p.indent ?? 0;
    const lines = wrap(p.text, font, sz, right - left - ind, measure);
    if (lines.length === 0) continue;
    const lh = sz * line;
    const gap = first ? 0 : p.before * size;
    // A heading stays with the first two lines of what follows it.
    const need = lh * (p.keepWithNext ? lines.length + 2 : Math.min(lines.length, 2)) + gap;
    if (!first && y - need < bottom - lh * 0.25) {
      pages.push([]);
      y = top;
    } else {
      y -= gap;
    }
    first = false;
    for (const line of lines) {
      if (y - lh < bottom - lh * 0.25 && pages[pages.length - 1]!.length > 0) {
        pages.push([]);
        y = top;
      }
      y -= lh;
      const w = line.width;
      const x = p.center ? (left + right - w) / 2 : p.dir === "rtl" ? right - ind - w : left + ind;
      // Baseline sits a little above the line's bottom so descenders stay inside the margin.
      pages[pages.length - 1]!.push({ logical: line.text, x, y: y + lh * 0.22, width: w, size: sz, bold: p.bold, font: fontName(fonts, font), dir: p.dir, role: p.role });
    }
  }
  return { size, pages };
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
  while (plan.pages.length < targetPages) plan.pages.push([]);

  for (const ops of plan.pages) {
    const page = doc.addPage([input.page.width, input.page.height]);
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
  }
  const bytes = await doc.save();
  return { bytes, pages: plan.pages.length, targetPages, fontSize: plan.size, pagesAtMinSize, lastPageFill, strippedMarks: false, plan };
}
