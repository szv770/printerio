import {
  PDFHexString,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  type Color,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { hasHebrew } from "@/lib/booklet/bidi";

/**
 * Hebrew with its vowel points and cantillation marks, drawn the way the font intends.
 *
 * pdf-lib asks the font library to lay a string out, then keeps only the glyph numbers and throws the positions away. Hebrew fonts
 * place their marks with those positions (the OpenType GPOS "mark" and "mkmk" tables: this mark sits under that letter, this one above
 * the first), so with pdf-lib's own drawText every vowel and trop mark lands at the letter's default spot: crowded, overlapping,
 * floating apart from their letters. Here the same layout is read in full and every glyph is drawn at its own offset.
 *
 * Only text with Hebrew letters takes this path; everything else (English, numbers alone) keeps using drawText unchanged.
 * The text itself is never changed: the same glyphs are embedded the same way (so the PDF's text map still holds every character).
 */

interface Position {
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}
interface FkGlyph {
  id: number;
}
interface FkFont {
  unitsPerEm: number;
  layout(text: string, features?: unknown): { glyphs: FkGlyph[]; positions: Position[] };
}
interface Embedder {
  font: FkFont;
  fontFeatures?: unknown;
  /** Only the subset embedder: tracks which glyphs are written into the PDF and what text each one stands for. */
  subset?: { includeGlyph(glyph: FkGlyph): number };
  glyphs?: FkGlyph[];
  glyphIdMap?: Map<number, number>;
  glyphCache?: { invalidate(): void };
}

/** The font library's own font behind an embedded PDF font, or null for the PDF's built-in fonts (which have no positions to read). */
function embedderOf(font: PDFFont): Embedder | null {
  const e = (font as unknown as { embedder?: Embedder }).embedder;
  return e && e.font && typeof e.font.layout === "function" ? e : null;
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

function shape(font: PDFFont, text: string): { e: Embedder; glyphs: FkGlyph[]; positions: Position[] } | null {
  if (!hasHebrew(text)) return null;
  const e = embedderOf(font);
  if (!e) return null;
  const run = e.font.layout(text, e.fontFeatures);
  return { e, glyphs: run.glyphs, positions: run.positions };
}

/** The width of a piece of text: marks that sit over a letter add nothing, exactly as drawn by `drawShaped`. */
export function widthOfShaped(font: PDFFont, text: string, size: number): number {
  const s = shape(font, text);
  if (!s) return font.widthOfTextAtSize(text, size);
  let units = 0;
  for (const p of s.positions) units += p.xAdvance;
  return (units * size) / s.e.font.unitsPerEm;
}

/** Draws one piece of text at `x`, `y` (baseline), like `page.drawText`, with every Hebrew glyph at the position the font gives it. */
export function drawShaped(page: PDFPage, text: string, o: { x: number; y: number; size: number; font: PDFFont; color: Color }): void {
  const s = shape(o.font, text);
  if (!s) {
    page.drawText(text, o);
    return;
  }
  const { e, glyphs, positions } = s;
  // The code a glyph has in this PDF font: its number in the shrunken copy of the font, or its own number when the font is embedded whole.
  const codes = glyphs.map((g) => {
    if (!e.subset) return hex4(g.id);
    const id = e.subset.includeGlyph(g);
    if (e.glyphs) e.glyphs[id - 1] = g;
    e.glyphIdMap?.set(g.id, id);
    return hex4(id);
  });
  e.glyphCache?.invalidate();

  const key = page.node.newFontDictionary(o.font.name, o.font.ref);
  const k = o.size / e.font.unitsPerEm;
  const ops = [pushGraphicsState(), setFillingColor(o.color), beginText(), setFontAndSize(key, o.size)];
  let pen = o.x;
  glyphs.forEach((_, i) => {
    const p = positions[i]!;
    ops.push(setTextMatrix(1, 0, 0, 1, pen + p.xOffset * k, o.y + p.yOffset * k), showText(PDFHexString.of(codes[i]!)));
    pen += p.xAdvance * k;
  });
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}
