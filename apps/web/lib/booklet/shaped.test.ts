import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { EZRA_SIL_REGULAR_BASE64 } from "@/lib/booklet/fonts/ezra-sil-regular";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@/lib/booklet/fonts/david-libre-regular";
import { nonAscii, pageTexts } from "@/test/hebrew-fixtures";
import { drawShaped, widthOfShaped } from "./shaped";

const EZRA = Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64");
const DAVID = Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64");
// Logical order, as stored. Every marked word needs the font to move its marks off the letter's default spot.
const TEXT = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים";

/** Every stream of the saved PDF, decompressed, as text: enough to read the page's drawing commands. */
function streams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out.push(inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"));
    } catch {
      out.push(m[1]!);
    }
  }
  return out.join("\n");
}

async function setup(bytes: Buffer, subset: boolean) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(bytes, { subset });
  return { doc, font, page: doc.addPage([400, 100]) };
}

describe("drawShaped", () => {
  it("the font really offsets marks, which pdf-lib's drawText would discard", async () => {
    const { font } = await setup(EZRA, true);
    const e = (font as unknown as { embedder: { font: { layout(t: string): { positions: { xOffset: number; yOffset: number }[] } } } }).embedder;
    expect(e.font.layout(TEXT).positions.some((p) => p.xOffset !== 0 || p.yOffset !== 0)).toBe(true);
  });

  it("draws every glyph with its own matrix at the offset the font gives it", async () => {
    const { doc, font, page } = await setup(EZRA, true);
    drawShaped(page, TEXT, { x: 20, y: 40, size: 20, font, color: rgb(0, 0, 0) });
    const content = streams(await doc.save({ useObjectStreams: false }));
    // One text matrix per glyph (more than there are characters of letters alone), and the glyphs do not all share one x step:
    // a mark sits where the font puts it, not where plain advancing would.
    const xs = [...content.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(10);
    const steps = new Set(xs.slice(1).map((x, i) => (x - xs[i]!).toFixed(2)));
    expect(steps.size).toBeGreaterThan(3);
  });

  it("keeps the text readable: the same letters and marks come back out of the PDF", async () => {
    const { doc, font, page } = await setup(EZRA, true);
    drawShaped(page, TEXT, { x: 20, y: 40, size: 20, font, color: rgb(0, 0, 0) });
    const bytes = await doc.save();
    const extracted = nonAscii((await pageTexts(bytes)).flat());
    // Compare as sets of characters: the order depends on how a reader joins separately drawn glyphs.
    const chars = (s: string) => [...s].filter((c) => c.trim()).sort().join("");
    expect(chars(extracted)).toBe(chars(TEXT));
  });

  it("measures what it draws: marks add no width, and it agrees with the font library's own advances", async () => {
    const { font } = await setup(EZRA, true);
    const w = widthOfShaped(font, TEXT, 20);
    expect(w).toBeGreaterThan(0);
    // The plain width is the sum of every glyph's own advance; kerning and mark adjustments can only move it a little.
    expect(Math.abs(w - font.widthOfTextAtSize(TEXT, 20)) / w).toBeLessThan(0.05);
  });

  it("leaves text without Hebrew letters to drawText and the normal width", async () => {
    const { doc, font, page } = await setup(DAVID, true);
    drawShaped(page, "Daily study 5", { x: 20, y: 40, size: 12, font, color: rgb(0, 0, 0) });
    expect(widthOfShaped(font, "Daily study 5", 12)).toBe(font.widthOfTextAtSize("Daily study 5", 12));
    const content = streams(await doc.save({ useObjectStreams: false }));
    // drawText writes a single text matrix for the whole string; glyph-by-glyph drawing writes one per glyph.
    expect([...content.matchAll(/ Tm/g)].length).toBe(1);
  });

  it("works when the font is embedded whole (needed for .otf fonts) as well as shrunk", async () => {
    const { doc, font, page } = await setup(EZRA, false);
    drawShaped(page, TEXT, { x: 20, y: 40, size: 20, font, color: rgb(0, 0, 0) });
    const extracted = nonAscii((await pageTexts(await doc.save())).flat());
    // A whole-font embed can only map glyphs that have their own character, so a composed glyph may lose its mapping: nearly all text survives.
    expect([...extracted].filter((c) => c.trim()).length).toBeGreaterThanOrEqual([...TEXT].filter((c) => c.trim()).length - 2);
  });
});
