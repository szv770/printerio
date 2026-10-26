import "server-only";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { hasHebrew, paragraphDirection, visualRuns, type Direction } from "./bidi";
import { DAVID_LIBRE_BOLD_BASE64 } from "./fonts/david-libre-bold";
import { DAVID_LIBRE_REGULAR_BASE64 } from "./fonts/david-libre-regular";

/**
 * The cover and contents pages of a booklet built from several sources. Text is laid out in David Libre (Hebrew and
 * Latin), each line in its own direction (lib/booklet/bidi.ts), and a Hebrew booklet mirrors the whole layout:
 * right-aligned titles, page numbers on the left.
 */

export interface FrontEntry {
  title: string;
  startPage: number;
}

export interface FrontMatterInput {
  title: string;
  description: string;
  /** The booklet's reading direction (set by its binding): decides alignment and the contents heading. */
  direction: Direction;
  entries: FrontEntry[];
  /** Distinct "Courtesy of ..." names, shown at the bottom of the last contents page. */
  credits: string[];
  cover: boolean;
  contents: boolean;
  /** The size of the front pages: the size of the first content page. */
  size: { width: number; height: number };
}

const INK = rgb(0.06, 0.12, 0.22);
const GRAY = rgb(0.36, 0.41, 0.5);
const LINE = rgb(0.78, 0.82, 0.88);

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64"), { subset: true });
  const bold = await doc.embedFont(Buffer.from(DAVID_LIBRE_BOLD_BASE64, "base64"), { subset: true });
  return { regular, bold };
}

/** Breaks text into lines that fit `maxWidth` (measured on the logical text: the width does not depend on direction). */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = clean(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the line is broken by letters rather than overflowing the page.
    let rest = word;
    while (width(rest) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && width(rest.slice(0, cut)) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The pieces of a line, left to right, with the text to hand to drawText for each. The font library lays out Hebrew itself
 * and reverses every Hebrew run (it assumes it was given logical order), so a Hebrew run is given back in reverse of the
 * visual order, and the library's reversal then lands the letters in visual order. Anything else is drawn as it is.
 */
export function drawableRuns(logical: string, dir: Direction): { visual: string; draw: string }[] {
  return visualRuns(logical, dir).map((r) => ({ visual: r.text, draw: r.rtl && hasHebrew(r.text) ? Array.from(r.text).reverse().join("") : r.text }));
}

/** Draws one logical line at the start edge (right for right-to-left text) or centered, in visual order. */
function drawLine(page: PDFPage, logical: string, font: PDFFont, size: number, o: { x0: number; x1: number; y: number; dir: Direction; center?: boolean; color?: ReturnType<typeof rgb> }): number {
  const runs = drawableRuns(logical, o.dir).map((r) => ({ ...r, w: font.widthOfTextAtSize(r.draw, size) }));
  const w = runs.reduce((sum, r) => sum + r.w, 0);
  let x = o.center ? (o.x0 + o.x1 - w) / 2 : o.dir === "rtl" ? o.x1 - w : o.x0;
  for (const r of runs) {
    page.drawText(r.draw, { x, y: o.y, size, font, color: o.color ?? INK });
    x += r.w;
  }
  return w;
}

const direct = (text: string, fallback: Direction): Direction => (/[֐-׿יִ-ﭏ]|[A-Za-z]/.test(text) ? paragraphDirection(text) : fallback);

function drawCover(doc: PDFDocument, fonts: Fonts, input: FrontMatterInput): void {
  const { width: W, height: H } = input.size;
  const page = doc.addPage([W, H]);
  const margin = W * 0.14;
  const maxW = W - 2 * margin;
  const title = clean(input.title) || "Booklet";

  // Shrink the title until it fits in at most four lines.
  let size = Math.min(44, W / 12);
  let lines = wrapText(title, fonts.bold, size, maxW);
  while (lines.length > 4 && size > 18) {
    size -= 2;
    lines = wrapText(title, fonts.bold, size, maxW);
  }
  const lead = size * 1.2;
  const descSize = Math.max(11, Math.min(17, W / 36));
  const descLines = clean(input.description) ? wrapText(input.description, fonts.regular, descSize, maxW).slice(0, 8) : [];
  const descLead = descSize * 1.5;

  const blockHeight = lines.length * lead + (descLines.length ? 40 + descLines.length * descLead : 0);
  let y = H * 0.56 + blockHeight / 2 - size;
  const dir = direct(title, input.direction);
  for (const line of lines) {
    drawLine(page, line, fonts.bold, size, { x0: margin, x1: W - margin, y, dir: direct(line, dir), center: true });
    y -= lead;
  }
  if (descLines.length) {
    y -= 8;
    page.drawLine({ start: { x: W / 2 - 28, y }, end: { x: W / 2 + 28, y }, thickness: 1.5, color: LINE });
    y -= 26;
    for (const line of descLines) {
      drawLine(page, line, fonts.regular, descSize, { x0: margin, x1: W - margin, y, dir: direct(line, input.direction), center: true, color: GRAY });
      y -= descLead;
    }
  }
}

const HEADING = { ltr: "Contents", rtl: "תוכן ענינים" } as const;
const COURTESY = { ltr: "Courtesy of", rtl: "באדיבות" } as const;

interface ContentsLayout {
  rows: Array<{ lines: string[]; startPage: number }>[];
  titleSize: number;
  lead: number;
  maxTitleWidth: number;
}

/** Works out which entries go on which contents page. Depends only on the titles, so it can run before page numbers exist. */
export function layoutContents(fonts: Fonts, entries: readonly FrontEntry[], size: { width: number; height: number }): ContentsLayout {
  const { width: W, height: H } = size;
  const margin = W * 0.14;
  const titleSize = Math.max(11, Math.min(15, W / 40));
  const lead = titleSize * 1.35;
  const maxTitleWidth = W - 2 * margin - 54; // room for the page number and its leader
  const top = H - margin - 70;
  const bottom = margin + 28; // keeps the credits line clear
  const rowGap = titleSize * 0.8;

  const pages: ContentsLayout["rows"] = [[]];
  let y = top;
  for (const e of entries) {
    const lines = wrapText(e.title || "Untitled", fonts.regular, titleSize, maxTitleWidth).slice(0, 3);
    const need = lines.length * lead + rowGap;
    if (y - need < bottom && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      y = top;
    }
    pages[pages.length - 1]!.push({ lines, startPage: e.startPage });
    y -= need;
  }
  return { rows: pages, titleSize, lead, maxTitleWidth };
}

function drawContents(doc: PDFDocument, fonts: Fonts, input: FrontMatterInput, layout: ContentsLayout): void {
  const { width: W, height: H } = input.size;
  const margin = W * 0.14;
  const rowGap = layout.titleSize * 0.8;
  const rtl = input.direction === "rtl";
  const credits = input.credits.map(clean).filter(Boolean);

  layout.rows.forEach((rows, pageIndex) => {
    const page = doc.addPage([W, H]);
    drawLine(page, HEADING[input.direction], fonts.bold, Math.min(30, W / 20), { x0: margin, x1: W - margin, y: H - margin - 28, dir: input.direction });
    page.drawLine({ start: { x: margin, y: H - margin - 42 }, end: { x: W - margin, y: H - margin - 42 }, thickness: 1, color: LINE });

    let y = H - margin - 70;
    for (const row of rows) {
      const first = y;
      let lastWidth = 0;
      row.lines.forEach((line, i) => {
        // Titles sit at the start edge of the booklet's direction, even when one title is in the other language.
        const w = drawLine(page, line, fonts.regular, layout.titleSize, { x0: margin + (rtl ? 54 : 0), x1: W - margin - (rtl ? 0 : 54), y, dir: rtl ? "rtl" : "ltr" });
        if (i === row.lines.length - 1) lastWidth = w;
        y -= layout.lead;
      });
      // Page number on the far edge, with a dotted leader across the gap after the last line of the title.
      const num = String(row.startPage);
      const numW = fonts.regular.widthOfTextAtSize(num, layout.titleSize);
      const baseline = first - (row.lines.length - 1) * layout.lead;
      const numX = rtl ? margin : W - margin - numW;
      page.drawText(num, { x: numX, y: baseline, size: layout.titleSize, font: fonts.regular, color: INK });
      const gapStart = rtl ? margin + numW + 8 : margin + lastWidth + 8;
      const gapEnd = rtl ? W - margin - lastWidth - 8 : W - margin - numW - 8;
      for (let x = Math.min(gapStart, gapEnd); x < Math.max(gapStart, gapEnd); x += 5) {
        page.drawCircle({ x, y: baseline + layout.titleSize * 0.18, size: 0.55, color: LINE });
      }
      y -= rowGap;
    }

    if (pageIndex === layout.rows.length - 1 && credits.length > 0) {
      const text = `${COURTESY[input.direction]}: ${credits.join("; ")}`;
      const lines = wrapText(text, fonts.regular, 9.5, W - 2 * margin).slice(0, 3);
      let cy = margin - 6 + (lines.length - 1) * 13;
      for (const line of lines) {
        drawLine(page, line, fonts.regular, 9.5, { x0: margin, x1: W - margin, y: cy, dir: rtl ? "rtl" : direct(line, "ltr"), color: GRAY });
        cy -= 13;
      }
    }
  });
}

/** How many pages the cover and contents will take, so the sources' page numbers can be worked out first. */
export async function frontMatterPageCount(input: Omit<FrontMatterInput, "credits"> & { credits?: string[] }): Promise<number> {
  const scratch = await PDFDocument.create();
  const fonts = await embedFonts(scratch);
  const contentsPages = input.contents ? layoutContents(fonts, input.entries, input.size).rows.length : 0;
  return (input.cover ? 1 : 0) + contentsPages;
}

/** Adds the cover (if asked) and then the contents pages (if asked) to `doc`, at the end of what it already holds. */
export async function addFrontMatter(doc: PDFDocument, input: FrontMatterInput): Promise<number> {
  const fonts = await embedFonts(doc);
  let added = 0;
  if (input.cover) {
    drawCover(doc, fonts, input);
    added += 1;
  }
  if (input.contents) {
    const layout = layoutContents(fonts, input.entries, input.size);
    drawContents(doc, fonts, input, layout);
    added += layout.rows.length;
  }
  return added;
}
