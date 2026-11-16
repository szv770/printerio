import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import { EZRA_SIL_REGULAR_BASE64 } from "@/lib/booklet/fonts/ezra-sil-regular";
import { drawShaped, widthOfShaped } from "@/lib/booklet/shaped";
import { drawableRuns, embedFonts, embedHebrewFont, embedLatinFont, type Fonts, type LatinFontBytes } from "@/lib/booklet/frontmatter";
import { hasHebrew, paragraphDirection, type Direction } from "@/lib/booklet/bidi";
import type { StudySection } from "@printio/shared/library/daily/page";

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
 * English is usually longer than the Hebrew it translates, so the two columns need not be equal: `columns` "auto" measures the
 * text of each study and gives Hebrew between 30% and 50% of the width, whichever makes the shortest pages (see chooseHebrewShare).
 * Text is only drawn, never changed: Hebrew is set in Ezra SIL, which has every vowel and cantillation mark; English in David Libre.
 * Optional fonts, by job: `hebrewFont` (Hebrew body), `titleFont` (Hebrew in titles only, drawn as it is), `rashiFont` (Hebrew in
 * Rashi), `latinFont` (all text that is not Hebrew: regular for the body, bold for titles) and `latinRashiFont` (English in Rashi);
 * a line that mixes scripts is drawn piece by piece, each piece in a font that has it. Titles can also have a Hebrew form (`titleHe`).
 * With `cover` the first page is a front page (title, dates, what is inside, no page numbers) and the text starts on page 2;
 * with `footer` every page of text has a thin rule, the date and the page number at the bottom.
 * See docs/daily-study.md.
 */

export type Language = "he" | "en" | "both";

/** How the width is shared when both languages are side by side: measured per study, or a fixed Hebrew / English split. */
export type ColumnSplit = "auto" | "even" | "wider" | "much";
/** The Hebrew column's share of the two columns for each fixed choice: Even 50/50, Wider English 40/60, Much wider English 33/67. */
export const COLUMN_SHARES: Record<Exclude<ColumnSplit, "auto">, number> = { even: 0.5, wider: 0.4, much: 0.33 };
export const MIN_HEBREW_SHARE = 0.3;
export const MAX_HEBREW_SHARE = 0.5;

/** English regular and bold (David Libre unless `latinFont`), Hebrew (Ezra SIL unless an uploaded font was given) and the fonts for titles and Rashi, if any. */
interface LayoutFonts extends Fonts {
  hebrew: PDFFont;
  /** Hebrew in Rashi, when a font was given for it. */
  rashi?: PDFFont;
  /** English in Rashi, when a font was given for it. */
  rashiLatin?: PDFFont;
  /** An English font replaced David Libre, so Hebrew letters inside English text need the Hebrew font. */
  latinReplaced: boolean;
}
type FontKind = DrawOp["font"];
const kindFont = (f: LayoutFonts, kind: FontKind): PDFFont =>
  kind === "title" ? f.title ?? f.hebrew : kind === "hebrew" ? f.hebrew : kind === "rashi" ? f.rashi ?? f.hebrew : kind === "rashiLatin" ? f.rashiLatin ?? f.regular : kind === "bold" ? f.bold : f.regular;
/** A Hebrew title is drawn in the title font when there is one, else the body Hebrew font; Rashi likewise falls back to the body fonts. */
const resolveKind = (f: LayoutFonts, kind: Para["kind"]): FontKind =>
  kind === "title" ? (f.title ? "title" : "hebrew") : kind === "rashi" ? (f.rashi ? "rashi" : "hebrew") : kind === "rashiLatin" ? (f.rashiLatin ? "rashiLatin" : "regular") : kind;

const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;
const charSets = new WeakMap<PDFFont, Set<number>>();
const hasLetters = (font: PDFFont, text: string): boolean => {
  let set = charSets.get(font);
  if (!set) charSets.set(font, (set = new Set(font.getCharacterSet())));
  return Array.from(text).every((ch) => !LATIN_LETTER.test(ch) || set!.has(ch.codePointAt(0)!));
};

/**
 * The font that draws one piece of a line (a run of one direction): a Hebrew font never draws English letters, nor an English font
 * Hebrew letters. Titles always take Latin pieces from the English bold font; a Hebrew paragraph only when its font lacks the letters.
 */
function pieceKind(f: LayoutFonts, kind: FontKind, text: string): FontKind {
  if (kind === "hebrew" || kind === "title" || kind === "rashi") {
    if (hasHebrew(text) || !LATIN_LETTER.test(text)) return kind;
    if (kind === "title") return "bold";
    if (hasLetters(kindFont(f, kind), text)) return kind;
    return kind === "rashi" && f.rashiLatin ? "rashiLatin" : "regular";
  }
  if (kind === "rashiLatin") return hasHebrew(text) ? (f.rashi ? "rashi" : "hebrew") : kind;
  return f.latinReplaced && hasHebrew(text) ? "hebrew" : kind;
}

export interface FillItem {
  title: string;
  /** The item's title in Hebrew (e.g. "חומש - פרשת בראשית"): drawn instead of, or above, the English title, by the booklet's language. */
  titleHe?: string;
  sections: StudySection[];
  /** A larger, centred heading drawn before this item: the day (a booklet arranged by day) or the study (arranged by study). Set on the first item of each group. */
  groupTitle?: string;
  groupTitleHe?: string;
  /** The words at the foot of the pages this item starts on (its date); the booklet's `footer` when absent. */
  footer?: string;
  footerHe?: string;
}

/** One line of the front page's list of what is inside: "Monday" + "Chumash with Rashi, Tanya". No page numbers. */
export interface ContentsRow {
  label: string;
  text: string;
  labelHe?: string;
  textHe?: string;
}

export interface CoverInput {
  /** The date (or the first and last day) in English and in Hebrew, under the title. */
  dateEn?: string;
  dateHe?: string;
  contents: ContentsRow[];
}

export interface FillInput {
  /** The booklet's title: on the front page when there is one, else at the top of the first page. */
  title: string;
  /** The booklet's title in Hebrew. Language "he": drawn alone (the English title if absent); "both": large, with the English title smaller beneath; "en": ignored. */
  titleHe?: string;
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
  /** How the two languages share the width (only with language "both"). Default "even". */
  columns?: ColumnSplit;
  /** A front page: the title, the dates and the list of what is inside. The text then starts on the second page. */
  cover?: CoverInput;
  /** The words at the foot of every page of text, next to the page number (an item's own `footer` wins on its pages). */
  footer?: { text?: string; textHe?: string };
  /** Bytes of an uploaded font (.ttf/.otf) to set Hebrew in instead of Ezra SIL. A font that cannot be read throws; there is no silent fallback. */
  hebrewFont?: Uint8Array;
  /** Bytes of a Hebrew-capable font (.ttf/.otf) for Hebrew text in titles and headings only, drawn as it is (never made bolder). Latin text in a title stays in the English bold font. Unreadable: throws. */
  titleFont?: Uint8Array;
  /** Bytes of a Hebrew font for the Hebrew of Rashi (e.g. the family's Regular or Light). Without it Rashi uses the body font. Unreadable: throws. */
  rashiFont?: Uint8Array;
  /** English (Latin) font used instead of David Libre for all text that is not Hebrew. Without `bold`, bold rows use the regular face. Unreadable: throws. */
  latinFont?: LatinFontBytes;
  /** An English font for the English of Rashi. Without it Rashi uses the English body font. Unreadable: throws. */
  latinRashiFont?: Uint8Array;
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
  /** Which font draws it: Hebrew paragraphs use "hebrew"; Hebrew titles "title" when a title font was given; Rashi "rashi" / "rashiLatin" when it has its own fonts. */
  font: "regular" | "bold" | "hebrew" | "title" | "rashi" | "rashiLatin";
  dir: Direction;
  role: "heading" | "body" | "credit" | "number" | "cover" | "footer";
}

/** A lightly shaded box behind Rashi. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A thin straight line: under a heading, above the footer, around the front page. */
export interface Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
}

/** A small diamond, the ornament in the middle of a centred rule. */
export interface Diamond {
  x: number;
  y: number;
  r: number;
}

export interface FillPlan {
  size: number;
  pages: DrawOp[][];
  rects: Rect[][];
  rules: Rule[][];
  diamonds: Diamond[][];
  /** The Hebrew column's share of the two columns for each item (0.3 to 0.5); empty unless both languages are shown. */
  shares: number[];
  /** For each page, the item whose text comes first on it (-1: none). */
  pageItem: number[];
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
  /**
   * Marks in the Hebrew that is drawn which the Hebrew font has no glyph for (they would show as empty boxes). The text is still
   * drawn unchanged; the caller should warn. Always false for the bundled Ezra SIL.
   */
  missingMarks: { vowels: boolean; cantillation: boolean };
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
const SHADE = rgb(0.95, 0.945, 0.93);
const RULE = rgb(0.45, 0.45, 0.48);
/** Space between the Hebrew and English columns; the verse number sits in it. */
const GUTTER = 16;
const BOX_PAD = 4;

// The type scale, in body sizes: day or study group, study title, section heading, body, Rashi and notes, verse number, credit.
const SCALE = { title: 1.3, group: 1.32, item: 1.15, section: 1.02, body: 1, rashi: 0.9, number: 0.8, credit: 0.75 };

interface Para {
  text: string;
  kind: "regular" | "bold" | "hebrew" | "title" | "rashi" | "rashiLatin";
  /** A right-to-left line kept at the left edge, where the English title next to it sits. */
  flushLeft?: boolean;
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
  /** A line drawn under the row: thin and full width under a study's title, short with a diamond under a group heading. */
  rule?: "thin" | "ornament";
  /** The item the row belongs to (-1: the booklet's own title or credit). */
  item: number;
}

/** One title line: Hebrew letters mean the title font (right-to-left), anything else the English bold font. */
const titleLine = (text: string, scale: number, flushLeft: boolean, before = 0): Para =>
  hasHebrew(text) ? { text, kind: "title", dir: paragraphDirection(text), scale, before, role: "heading", flushLeft } : { text, kind: "bold", dir: "ltr", scale, before, role: "heading" };

/**
 * A title or heading row. With a Hebrew form: language "he" draws only that; "both" draws it large with the English one smaller beneath,
 * both where the English title sits alone (centred for the booklet's title, at the left edge for the rest); "en" draws only the English.
 */
function heading(language: Language, text: string, textHe: string | undefined, scale: number, before: number, center = false, item = -1): Row {
  const he = textHe?.trim();
  const flushLeft = language !== "he";
  let left: Para[];
  if (he && language === "he") left = [titleLine(he, scale, false)];
  else if (he && language === "both" && text.trim()) left = [titleLine(he, scale * 1.2, flushLeft), titleLine(text, Math.max(0.85, scale * 0.72), flushLeft, 0.1)];
  else if (he && language === "both") left = [titleLine(he, scale * 1.2, flushLeft)];
  else left = [titleLine(text, scale, flushLeft)];
  return { left, right: [], full: true, center, keepWithNext: true, before, item };
}

function rows(input: FillInput): Row[] {
  // With a front page the title is there; without one it heads the first page of text, as it always did.
  const out: Row[] = input.cover ? [] : [heading(input.language, input.title, input.titleHe, SCALE.title, 0, true)];
  const both = input.language === "both";
  const he = (text: string, scale: number, before = 0, rashi = false): Para => ({ text, kind: rashi ? "rashi" : "hebrew", dir: "rtl", scale, before, role: "body" });
  // English is set in David Libre, which has the letters and vowel marks but no cantillation marks: leave those out of Hebrew words quoted inside English.
  // A non-breaking hyphen ("G‑d") is drawn as a plain hyphen: the English fonts have no glyph for it and would show an empty box.
  const en = (text: string, scale: number, before = 0, kind: Para["kind"] = "regular"): Para => ({ text: text.replace(/[֑-ֽ֯]/g, "").replace(/‑/g, "-"), kind, dir: "ltr", scale, before, role: "body" });

  input.items.forEach((item, idx) => {
    const grouped = !!(item.groupTitle?.trim() || item.groupTitleHe?.trim());
    if (grouped) {
      out.push({ ...heading(input.language, item.groupTitle ?? "", item.groupTitleHe, SCALE.group, out.length === 0 ? 0 : 1.5, true, idx), rule: "ornament" });
    }
    out.push({ ...heading(input.language, item.title, item.titleHe, SCALE.item, grouped ? 0.7 : 1, false, idx), rule: "thin" });
    for (const section of item.sections) {
      if (section.heading && section.heading !== item.title) out.push(heading(input.language, section.heading, undefined, SCALE.section, 0.7, false, idx));
      for (const b of section.blocks) {
        const rashi = b.kind === "rashi";
        const scale = rashi || b.kind === "note" ? SCALE.rashi : SCALE.body;
        const hePart: Para[] = [];
        const enPart: Para[] = [];
        if (rashi && b.leadHe) hePart.push(he(b.leadHe, scale, 0, true));
        if (b.he) hePart.push(he(b.he, scale, rashi && b.leadHe ? 0.15 : 0, rashi));
        if (rashi && b.leadEn) enPart.push(en(b.leadEn, scale, 0, "bold"));
        if (b.en) enPart.push(en(b.en, scale, rashi && b.leadEn ? 0.15 : 0, rashi ? "rashiLatin" : "regular"));
        const base = { before: rashi ? 0.5 : 0.55, item: idx, ...(rashi ? { shade: true } : {}) };
        if (both) {
          if (hePart.length === 0 && enPart.length === 0) continue;
          out.push({ left: hePart, right: enPart, full: false, num: b.kind === "verse" ? b.num : undefined, ...base });
        } else {
          const only = input.language === "he" ? hePart : enPart;
          if (only.length > 0) out.push({ left: only, right: [], full: true, ...base });
        }
      }
    }
  });
  if (input.credit) {
    out.push({ left: [{ text: input.credit, kind: "regular", dir: "ltr", scale: SCALE.credit, before: 0, role: "credit" }], right: [], full: true, center: true, before: 1.2, item: -1 });
  }
  return out;
}

/**
 * Measures each word once per font (text width is exactly proportional to the font size): measuring is the slow part of laying out many pages.
 * A word is measured piece by piece in the fonts that will draw it (see `pieceKind`).
 */
function measurer(fonts: LayoutFonts) {
  const cache = new Map<string, number>();
  return (kind: FontKind, size: number, text: string): number => {
    const key = `${kind}|${text}`;
    let unit = cache.get(key);
    if (unit === undefined) {
      unit = drawableRuns(text, "ltr").reduce((sum, r) => sum + widthOfShaped(kindFont(fonts, pieceKind(fonts, kind, r.visual)), r.draw, 1000), 0);
      cache.set(key, unit);
    }
    return (unit * size) / 1000;
  };
}
type Measure = ReturnType<typeof measurer>;

const wordsOf = (text: string): string[] => text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

/** Breaks text into lines that fit `maxWidth`; a word wider than a line is cut by letters rather than overflowing. */
function wrap(text: string, font: FontKind, size: number, maxWidth: number, measure: Measure): { text: string; width: number }[] {
  const words = wordsOf(text);
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

/** Breaks a list ("Chumash with Rashi, Tanya, Rambam (1 perek)") between its entries, never inside one (unless one entry is wider than a line). */
function wrapList(text: string, font: FontKind, size: number, maxWidth: number, measure: Measure): { text: string; width: number }[] {
  const lines: string[] = [];
  let line = "";
  for (const part of text.split(", ")) {
    const next = line ? `${line}, ${part}` : part;
    if (line && measure(font, size, `${next},`) > maxWidth) {
      lines.push(`${line},`);
      line = part;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.flatMap((l) => {
    const width = measure(font, size, l);
    return width > maxWidth ? wrap(l, font, size, maxWidth, measure) : [{ text: l, width }];
  });
}

/** One paragraph as the widths of its words (advance widths at the size it is set in) and of the space between them. */
export interface ParaWords {
  words: number[];
  space: number;
}

function paraWords(p: Para, fonts: LayoutFonts, size: number, measure: Measure): ParaWords {
  const font = resolveKind(fonts, p.kind);
  const sz = size * p.scale;
  return { words: wordsOf(p.text).map((w) => measure(font, sz, w)), space: measure(font, sz, " ") };
}

/** How many lines a paragraph takes in a column, breaking between words exactly as `wrap` does. */
function countLines(p: ParaWords, col: number): number {
  let lines = 0;
  let used = -1;
  for (const w of p.words) {
    if (used >= 0 && used + p.space + w <= col) used += p.space + w;
    else {
      // A word wider than the column is cut into several lines.
      lines += Math.max(1, Math.ceil(w / col - 1e-9));
      used = w > col ? w % col : w;
    }
  }
  return lines;
}

/** What one side-by-side row puts in each column: its Hebrew and English paragraphs, and the row's line height. */
export interface SharePair {
  he: ParaWords[];
  en: ParaWords[];
  /** The height of one line of the row (rows set smaller, like Rashi, count for less). */
  weight: number;
}

/**
 * The Hebrew column's share of the two columns' width. A fixed choice gives its own share (Even 0.5, Wider English 0.4, Much wider
 * English 0.33). "auto" tries every share from 50% down to 30%, counts the lines each column would really need (each row is as tall
 * as its taller column), and keeps the share that needs the least height. English is usually the longer, so it usually gets more
 * room; when the two are alike the split stays even. Of shares that are within 1% of the best, the one nearest 50/50 wins, so the
 * Hebrew column is not squeezed for nothing.
 */
export function chooseHebrewShare(pairs: readonly SharePair[], width: number, split: ColumnSplit = "auto"): number {
  if (split !== "auto") return COLUMN_SHARES[split];
  if (pairs.length === 0 || width <= 0) return MAX_HEBREW_SHARE;
  const lines = (paras: ParaWords[], col: number) => paras.reduce((n, p) => n + countLines(p, col), 0);
  const costs: { s: number; cost: number }[] = [];
  for (let pct = Math.round(MAX_HEBREW_SHARE * 100); pct >= Math.round(MIN_HEBREW_SHARE * 100); pct--) {
    const s = pct / 100;
    let cost = 0;
    for (const p of pairs) cost += p.weight * Math.max(lines(p.he, s * width), lines(p.en, (1 - s) * width));
    costs.push({ s, cost });
  }
  const best = Math.min(...costs.map((c) => c.cost));
  // `costs` runs from 50% down, so the first share that is good enough is the one nearest 50/50.
  return costs.find((c) => c.cost <= best * 1.01 + 1e-9)!.s;
}

/** One laid-out line of a column, waiting to be placed on a page. */
interface ColLine {
  text: string;
  width: number;
  size: number;
  font: FontKind;
  flushLeft: boolean;
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
    const font = resolveKind(fonts, p.kind);
    const lh = sz * line;
    wrap(p.text, font, sz, width, measure).forEach((l, li) => {
      out.push({ text: l.text, width: l.width, size: sz, font, flushLeft: !!p.flushLeft, dir: p.dir, role: p.role, lh, h: lh + (li === 0 && pi > 0 ? p.before * size : 0) });
    });
  });
  return out;
}

/** The room kept at the foot of a page of text for the rule, the date and the page number. */
const footerSize = (input: FillInput): number => Math.max(7, Math.min(9, input.margin * 0.28));
const hasFooter = (input: FillInput): boolean => !!input.footer || input.items.some((i) => i.footer || i.footerHe);
const footerBand = (input: FillInput): number => (hasFooter(input) ? footerSize(input) * 2.2 : 0);

function layout(input: FillInput, fonts: LayoutFonts, size: number, measure: Measure, line = LINE): FillPlan {
  const { width, height } = input.page;
  const m = input.margin;
  const left = m;
  const right = width - m;
  const top = height - m;
  const bottom = m + footerBand(input);
  const pages: DrawOp[][] = [[]];
  const rects: Rect[][] = [[]];
  const rules: Rule[][] = [[]];
  const diamonds: Diamond[][] = [[]];
  const pageItem: number[] = [-1];
  let y = top;
  let first = true;
  const newPage = () => {
    pages.push([]);
    rects.push([]);
    rules.push([]);
    diamonds.push([]);
    pageItem.push(-1);
    y = top;
  };
  const emit = (op: DrawOp) => pages[pages.length - 1]!.push(op);

  const all = rows(input);

  // The Hebrew share of each study's two columns, from the text that goes in them at this size.
  const split = input.columns ?? "even";
  const shares: number[] = [];
  if (input.language === "both") {
    const pairs = new Map<number, SharePair[]>();
    if (split === "auto") {
      for (const row of all) {
        if (row.full) continue;
        const list = pairs.get(row.item) ?? [];
        const scale = Math.max(...[...row.left, ...row.right].map((p) => p.scale), 0.1);
        list.push({ he: row.left.map((p) => paraWords(p, fonts, size, measure)), en: row.right.map((p) => paraWords(p, fonts, size, measure)), weight: scale });
        pairs.set(row.item, list);
      }
    }
    input.items.forEach((_, i) => shares.push(chooseHebrewShare(pairs.get(i) ?? [], right - left - GUTTER, split)));
  }

  const prepared = all.map((row) => {
    const pad = row.shade ? BOX_PAD : 0;
    const inner = right - left - 2 * pad;
    const share = shares[row.item] ?? 0.5;
    const heW = row.full ? inner : (inner - GUTTER) * share;
    const enW = row.full ? inner : inner - GUTTER - heW;
    const L = column(row.left, fonts, size, heW, line, measure);
    const R = row.full ? [] : column(row.right, fonts, size, enW, line, measure);
    const sum = (c: ColLine[]) => c.reduce((s, l) => s + l.h, 0);
    const ruleH = row.rule === "ornament" ? size * 1.1 : row.rule === "thin" ? size * 0.35 : 0;
    return { row, pad, heW, enW, L, R, ruleH, total: Math.max(sum(L), sum(R)) + 2 * pad + ruleH };
  });

  prepared.forEach((p, index) => {
    const { row, pad, heW, enW, L, R } = p;
    if (L.length === 0 && R.length === 0) return;
    const hebrewX = left + pad; // left column
    const englishX = left + pad + heW + GUTTER; // right column

    const gap = first ? 0 : row.before * size;
    const total = p.total;
    // Keep a short row together; a heading also stays with whatever follows it: the headings right after it and the first lines of the text.
    const pageH = top - bottom;
    let need = total + gap;
    if (row.keepWithNext) {
      let j = index + 1;
      while (j < prepared.length && prepared[j]!.row.keepWithNext) {
        need += prepared[j]!.total + prepared[j]!.row.before * size;
        j++;
      }
      const next = prepared[j];
      if (next) need += next.row.before * size + 2 * next.pad + Math.min(next.total, 2 * size * line);
    }
    const together = row.keepWithNext || total <= Math.max(4 * size * line, pageH * 0.18);
    if (!first && y - need < bottom - size * line * 0.2 && together && need <= pageH) newPage();
    else if (!first) y -= gap;
    first = false;

    let li = 0;
    let ri = 0;
    let startOfRow = true;
    while (li < L.length || ri < R.length) {
      // Take lines from each column until this page is full (at least one line, so a tall line never loops forever).
      const room = y - bottom + size * line * 0.2 - 2 * pad;
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
      const cy = y - pad;
      if (row.item >= 0 && pageItem[pageItem.length - 1] === -1) pageItem[pageItem.length - 1] = row.item;
      const place = (c: ColLine[], from: number, n: number, x0: number, x1: number, rtlSide: boolean) => {
        let yy = cy;
        for (let k = from; k < from + n; k++) {
          const l = c[k]!;
          const h = startOfRow && k === from ? l.lh : l.h;
          yy -= h;
          const x = row.center ? (left + right - l.width) / 2 : l.flushLeft ? x0 : l.dir === "rtl" || rtlSide ? x1 - l.width : x0;
          emit({ logical: l.text, x, y: yy + l.lh * 0.22, width: l.width, size: l.size, bold: l.font === "bold", font: l.font, dir: l.dir, role: l.role });
        }
      };
      if (row.full) place(L, li, a.n, hebrewX, hebrewX + heW, false);
      else {
        place(L, li, a.n, hebrewX, hebrewX + heW, true);
        place(R, ri, b.n, englishX, englishX + enW, false);
        if (row.num && startOfRow) {
          const numSize = size * SCALE.number;
          // Digits come from the English font when one was chosen (the Hebrew fonts are for Hebrew letters); Hebrew letter numbers stay Hebrew.
          const numKind: FontKind = fonts.latinReplaced && !hasHebrew(row.num) ? "regular" : "hebrew";
          const nw = measure(numKind, numSize, row.num);
          const lh0 = (L[0] ?? R[0])!.lh;
          emit({ logical: row.num, x: hebrewX + heW + (GUTTER - nw) / 2, y: cy - lh0 + lh0 * 0.22, width: nw, size: numSize, bold: false, font: numKind, dir: "rtl", role: "number" });
        }
      }
      if (row.shade) rects[rects.length - 1]!.push({ x: left, y: boxTop - used - 2 * pad, width: right - left, height: used + 2 * pad });
      y = boxTop - used - 2 * pad;
      li += a.n;
      ri += b.n;
      startOfRow = false;
      if (li < L.length || ri < R.length) newPage();
    }
    if (row.rule === "thin") {
      y -= p.ruleH;
      rules[rules.length - 1]!.push({ x1: left, y1: y, x2: right, y2: y, thickness: 0.5 });
    } else if (row.rule === "ornament") {
      const cx = (left + right) / 2;
      const ry = y - p.ruleH * 0.6;
      const half = (right - left) * 0.2;
      const r = size * 0.22;
      rules[rules.length - 1]!.push({ x1: cx - half, y1: ry, x2: cx - r * 2, y2: ry, thickness: 0.5 }, { x1: cx + r * 2, y1: ry, x2: cx + half, y2: ry, thickness: 0.5 });
      diamonds[diamonds.length - 1]!.push({ x: cx, y: ry, r });
      y -= p.ruleH;
    }
  });
  return { size, pages, rects, rules, diamonds, shares, pageItem };
}

function usedFraction(input: FillInput, plan: FillPlan): number {
  const last = plan.pages[plan.pages.length - 1] ?? [];
  if (last.length === 0) return 0;
  const m = input.margin;
  const bottom = m + footerBand(input);
  const lowest = Math.min(...last.map((o) => o.y));
  return Math.max(0, Math.min(1, (input.page.height - m - (lowest - bottom)) / (input.page.height - m - bottom)));
}

/** A booklet in Hebrew alone binds on the right, so its odd pages are on the left of an open spread. */
const outerIsRight = (input: FillInput, pageNumber: number): boolean => (input.language === "he" ? pageNumber % 2 === 0 : pageNumber % 2 === 1);

/**
 * The foot of one page of text: a thin rule, the page number at the outer edge, and the date at the inner edge (Hebrew for a Hebrew
 * booklet; with both languages the English date at the inner edge and the Hebrew date in the middle).
 */
function addFooter(input: FillInput, fonts: LayoutFonts, measure: Measure, plan: FillPlan, pageIndex: number, pageNumber: number): void {
  const item = input.items[plan.pageItem[pageIndex] ?? -1];
  const en = (item?.footer ?? input.footer?.text ?? "").trim();
  const he = (item?.footerHe ?? input.footer?.textHe ?? "").trim();
  const m = input.margin;
  const left = m;
  const right = input.page.width - m;
  const fs = footerSize(input);
  const y = m + fs * 0.2;
  const ops = plan.pages[pageIndex]!;
  const put = (text: string, where: "left" | "right" | "center") => {
    if (!text) return;
    const hebrew = hasHebrew(text);
    const font: FontKind = hebrew ? "hebrew" : "regular";
    const w = measure(font, fs, text);
    const x = where === "left" ? left : where === "right" ? right - w : (left + right - w) / 2;
    // In front of the page's own lines, so the last thing drawn on the last page is still the credit.
    ops.unshift({ logical: text, x, y, width: w, size: fs, bold: false, font, dir: hebrew ? "rtl" : "ltr", role: "footer" });
  };
  const outer = outerIsRight(input, pageNumber) ? "right" : "left";
  const inner = outer === "right" ? "left" : "right";
  put(String(pageNumber), outer);
  if (input.language === "he") put(he || en, inner);
  else if (input.language === "en") put(en, inner);
  else {
    put(en || he, inner);
    if (en && he) put(he, "center");
  }
  plan.rules[pageIndex]!.push({ x1: left, y1: m + fs * 1.35, x2: right, y2: m + fs * 1.35, thickness: 0.4 });
}

/**
 * The front page: a thin double frame, the title (Hebrew large, English beneath, by the booklet's language), an ornament, the dates,
 * and the list of what is inside, one row per day (or per study) with no page numbers. The list shrinks to fit a full week.
 */
function coverPage(input: FillInput, fonts: LayoutFonts, measure: Measure): { ops: DrawOp[]; rules: Rule[]; diamonds: Diamond[] } {
  const cover = input.cover!;
  const { width: W, height: H } = input.page;
  const u = W / 396;
  const lang = input.language;
  const ops: DrawOp[] = [];
  const rules: Rule[] = [];
  const diamonds: Diamond[] = [];

  const inset = Math.max(12, input.margin - 8 * u);
  for (const [d, thickness] of [[0, 0.9], [3 * u, 0.35]] as const) {
    const a = inset + d;
    rules.push(
      { x1: a, y1: a, x2: W - a, y2: a, thickness },
      { x1: a, y1: H - a, x2: W - a, y2: H - a, thickness },
      { x1: a, y1: a, x2: a, y2: H - a, thickness },
      { x1: W - a, y1: a, x2: W - a, y2: H - a, thickness },
    );
  }
  const x0 = inset + 22 * u;
  const x1 = W - inset - 22 * u;
  const maxW = x1 - x0;
  const regionTop = H - inset - 26 * u;
  const regionBottom = inset + 24 * u;

  /** Things stacked down the page: each knows its height and draws itself from its top edge. */
  const stack: { h: number; draw: (top: number) => void }[] = [];
  const gap = (h: number) => stack.push({ h, draw: () => undefined });
  const centred = (text: string | undefined, kind: Para["kind"], size: number) => {
    const t = text?.trim();
    if (!t) return;
    const font = resolveKind(fonts, kind);
    const lh = size * 1.25;
    for (const l of wrap(t, font, size, maxW, measure)) {
      stack.push({
        h: lh,
        draw: (top) => ops.push({ logical: l.text, x: (x0 + x1 - l.width) / 2, y: top - lh + lh * 0.25, width: l.width, size, bold: font === "bold", font, dir: hasHebrew(l.text) ? "rtl" : "ltr", role: "cover" }),
      });
    }
  };
  const ornament = (half: number) =>
    stack.push({
      h: 6 * u,
      draw: (top) => {
        const y = top - 3 * u;
        const cx = (x0 + x1) / 2;
        const r = 2.6 * u;
        rules.push({ x1: cx - half, y1: y, x2: cx - r * 2, y2: y, thickness: 0.6 }, { x1: cx + r * 2, y1: y, x2: cx + half, y2: y, thickness: 0.6 });
        diamonds.push({ x: cx, y, r });
      },
    });

  const titleHe = lang !== "en" ? input.titleHe?.trim() : undefined;
  if (titleHe) centred(titleHe, "title", 30 * u);
  if (lang !== "he" || !titleHe) {
    if (titleHe) gap(2 * u);
    centred(input.title, "bold", titleHe ? 17 * u : 27 * u);
  }
  gap(12 * u);
  ornament(maxW * 0.3);
  gap(12 * u);
  if (lang !== "en") centred(cover.dateHe, "hebrew", 13.5 * u);
  if (lang !== "he" || !cover.dateHe?.trim()) centred(cover.dateEn, "regular", 11.5 * u);

  // The list of what is inside. Each row: a label (the day, or the study) and what goes with it, Hebrew rows right-to-left.
  const variants = (row: ContentsRow): { label: string; text: string; he: boolean }[] => {
    const heRow = row.labelHe?.trim() || row.textHe?.trim() ? { label: row.labelHe?.trim() ?? "", text: row.textHe?.trim() ?? "", he: true } : null;
    const enRow = { label: row.label.trim(), text: row.text.trim(), he: false };
    if (lang === "he") return [heRow ?? enRow];
    if (lang === "en") return [enRow];
    return heRow ? [heRow, enRow] : [enRow];
  };
  const list = cover.contents.map(variants).filter((v) => v.length > 0);
  if (list.length > 0) {
    gap(24 * u);
    if (lang !== "en") centred("בחוברת זו", "title", 11.5 * u);
    if (lang !== "he") centred("In this booklet", "bold", lang === "both" ? 9 * u : 11 * u);
    gap(9 * u);
    const fixed = stack.reduce((s, b) => s + b.h, 0);
    const room = regionTop - regionBottom - fixed;
    const build = (cs: number) => {
      const blocks: { h: number; draw: (top: number) => void }[] = [];
      const labelKind = (he: boolean): FontKind => resolveKind(fonts, he ? "title" : "bold");
      const textKind = (he: boolean): FontKind => (he ? "hebrew" : "regular");
      const labelText = (l: string) => (l ? `${l}:` : "");
      const labelW = (he: boolean) => Math.max(0, ...list.flat().filter((v) => v.he === he && v.label).map((v) => measure(labelKind(he), cs, labelText(v.label)))) + cs * 0.7;
      const widths = { he: labelW(true), en: labelW(false) };
      const lh = cs * 1.3;
      list.forEach((vs, di) => {
        if (di > 0) blocks.push({ h: cs * (lang === "both" ? 0.75 : 0.45), draw: () => undefined });
        for (const v of vs) {
          const lw = Math.min(v.he ? widths.he : widths.en, maxW * 0.45);
          const lines = wrapList(v.text, textKind(v.he), cs, maxW - lw, measure);
          const n = Math.max(1, lines.length);
          blocks.push({
            h: n * lh,
            draw: (top) => {
              const base = (i: number) => top - (i + 1) * lh + lh * 0.25;
              if (v.label) {
                const t = labelText(v.label);
                const w = measure(labelKind(v.he), cs, t);
                ops.push({ logical: t, x: v.he ? x1 - w : x0, y: base(0), width: w, size: cs, bold: !v.he, font: labelKind(v.he), dir: v.he ? "rtl" : "ltr", role: "cover" });
              }
              lines.forEach((l, i) => {
                ops.push({ logical: l.text, x: v.he ? x1 - lw - l.width : x0 + lw, y: base(i), width: l.width, size: cs, bold: false, font: textKind(v.he), dir: v.he ? "rtl" : "ltr", role: "cover" });
              });
            },
          });
        }
      });
      return { blocks, h: blocks.reduce((s, b) => s + b.h, 0) };
    };
    let cs = 11 * u;
    let built = build(cs);
    while (built.h > room && cs > 5.5 * u) {
      cs -= 0.5 * u;
      built = build(cs);
    }
    stack.push(...built.blocks);
  }

  // Sit a little above the middle of the frame, as a title page does.
  const total = stack.reduce((s, b) => s + b.h, 0);
  let top = regionTop - Math.max(0, regionTop - regionBottom - total) * 0.36;
  for (const b of stack) {
    b.draw(top);
    top -= b.h;
  }
  return { ops, rules, diamonds };
}

/** Vowel points (incl. shin/sin dots and qamats qatan) and cantillation marks. */
const VOWEL = /[ְ-ׇּׁׂ]/;
const CANTILLATION = /[֑-֯]/;

/** Which kinds of marks the drawn Hebrew uses that `font` has no glyph for. Nothing is removed from the text. `kind` says which lines the font draws. */
export function findMissingMarks(plan: FillPlan, font: Pick<PDFFont, "getCharacterSet">, kind: DrawOp["font"] = "hebrew"): { vowels: boolean; cantillation: boolean } {
  const have = new Set(font.getCharacterSet());
  const out = { vowels: false, cantillation: false };
  for (const op of plan.pages.flat()) {
    if (op.font !== kind) continue;
    for (const ch of op.logical) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x0591 || cp > 0x05c7 || have.has(cp)) continue;
      if (VOWEL.test(ch)) out.vowels = true;
      else if (CANTILLATION.test(ch)) out.cantillation = true;
    }
    if (out.vowels && out.cantillation) break;
  }
  return out;
}

export async function buildFilledPdf(input: FillInput): Promise<FillResult> {
  const doc = await PDFDocument.create();
  const base = await embedFonts(doc, input.hebrewFont ?? new Uint8Array(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64")), {
    ...(input.latinFont ? { latinFont: input.latinFont } : {}),
    ...(input.titleFont ? { titleFont: input.titleFont } : {}),
  });
  const fonts: LayoutFonts = { ...base, hebrew: base.hebrew!, latinReplaced: !!input.latinFont };
  if (input.rashiFont) fonts.rashi = await embedHebrewFont(doc, input.rashiFont);
  if (input.latinRashiFont) fonts.rashiLatin = await embedLatinFont(doc, input.latinRashiFont);
  const minSize = input.minSize ?? MIN_SIZE;
  const maxSize = input.maxSize ?? MAX_SIZE;

  const measure = measurer(fonts);
  // The front page is one whole page before the text.
  const extra = input.cover ? 1 : 0;
  const atMin = layout(input, fonts, minSize, measure);
  const pagesAtMinSize = atMin.pages.length + extra;
  const targetPages = Math.max(4, Math.ceil(pagesAtMinSize / 4) * 4);
  const fits = (p: FillPlan) => p.pages.length + extra <= targetPages;

  // Page count only grows with the font size, so a binary search over the sizes finds the largest one that still fits.
  const steps = Math.max(0, Math.floor((maxSize - minSize) / STEP + 1e-9));
  let plan = atMin;
  let lo = 0;
  let hi = steps;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const trial = layout(input, fonts, minSize + mid * STEP, measure);
    if (fits(trial)) {
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
    if (fits(trial)) {
      plan = trial;
      llo = mid;
    } else {
      lhi = mid - 1;
    }
  }

  const lastPageFill = usedFraction(input, plan);
  if (hasFooter(input)) plan.pages.forEach((ops, i) => ops.length > 0 && addFooter(input, fonts, measure, plan, i, i + 1 + extra));
  if (input.cover) {
    const front = coverPage(input, fonts, measure);
    plan.pages.unshift(front.ops);
    plan.rects.unshift([]);
    plan.rules.unshift(front.rules);
    plan.diamonds.unshift(front.diamonds);
    plan.pageItem.unshift(-1);
  }
  while (plan.pages.length < targetPages) {
    plan.pages.push([]);
    plan.rects.push([]);
    plan.rules.push([]);
    plan.diamonds.push([]);
    plan.pageItem.push(-1);
  }

  plan.pages.forEach((ops, pi) => {
    const page = doc.addPage([input.page.width, input.page.height]);
    for (const r of plan.rects[pi] ?? []) page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: SHADE });
    for (const l of plan.rules[pi] ?? []) page.drawLine({ start: { x: l.x1, y: l.y1 }, end: { x: l.x2, y: l.y2 }, thickness: l.thickness, color: RULE });
    for (const d of plan.diamonds[pi] ?? []) page.drawSvgPath(`M 0 ${-d.r} L ${d.r} 0 L 0 ${d.r} L ${-d.r} 0 Z`, { x: d.x, y: d.y, color: RULE });
    for (const op of ops) {
      let x = op.x;
      const runs = drawableRuns(op.logical, op.dir);
      for (const r of runs) {
        const font = kindFont(fonts, pieceKind(fonts, op.font, r.visual));
        drawShaped(page, r.draw, { x, y: op.y, size: op.size, font, color: INK });
        // Only a line made of several pieces needs each piece measured; the usual single piece does not.
        if (runs.length > 1) x += widthOfShaped(font, r.draw, op.size);
      }
    }
  });
  const bytes = await doc.save();
  const none = { vowels: false, cantillation: false };
  const body = input.hebrewFont ? findMissingMarks(plan, fonts.hebrew) : none;
  const rashi = fonts.rashi ? findMissingMarks(plan, fonts.rashi, "rashi") : none;
  const missingMarks = { vowels: body.vowels || rashi.vowels, cantillation: body.cantillation || rashi.cantillation };
  return { bytes, pages: plan.pages.length, targetPages, fontSize: plan.size, pagesAtMinSize, lastPageFill, strippedMarks: false, missingMarks, plan };
}
