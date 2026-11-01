// Does any step Printio applies to a PDF change its Hebrew text or drop a font? Every fixture goes through the real
// stages in the order create-print-job.ts runs them; what a viewer extracts (pdfjs) and the fonts used must survive.
import { describe, expect, it, vi } from "vitest";

// The first test loads pdfjs, which takes seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });
import { PDFDocument } from "pdf-lib";
import { bookletPageOrder } from "./imposition";
import { fontsWithToUnicode, HEBREW_LINES, makeHebrewPdf, MIXED_LINES, nonAscii, pageFonts, pageTexts, type FixtureOptions } from "@/test/hebrew-fixtures";
import { preflightPdf } from "./preflight";
import { createPageSubsetPdf } from "./page-subset";
import { padAndImposeBooklet } from "./booklet-build";
import { stampFirstPage } from "./stamp";

const FIXTURES: Record<string, FixtureOptions> = {
  "(a) subset font": { subset: true },
  "(b) full font": { subset: false },
  "(c) mixed Hebrew, Latin, digits, nikud": { pages: [MIXED_LINES] },
  "(d) multi-page": { pages: [HEBREW_LINES, MIXED_LINES, ["עמוד שלישי"], ["עמוד רביעי", "סוף"], ["חמישי"]] },
  "(e) attachment + JavaScript (sanitize runs)": { active: true, pages: [MIXED_LINES, HEBREW_LINES] },
  "(f) landscape / odd size": { size: [842, 595], pages: [MIXED_LINES, HEBREW_LINES] },
  "(f2) odd size": { size: [300, 500], pages: [HEBREW_LINES] },
  "(g) /Rotate 90": { rotate: 90, pages: [HEBREW_LINES, MIXED_LINES] },
  "(g2) /Rotate 270": { rotate: 270, pages: [MIXED_LINES] },
  "(h) object streams": { objectStreams: true, pages: [MIXED_LINES, HEBREW_LINES] },
  "(i) inherited Resources / MediaBox / Rotate": { inherit: true, rotate: 90, pages: [HEBREW_LINES, MIXED_LINES] },
};

const chars = (s: string) => [...s].sort().join("");
const STAMP = { text: "SV42 2026-11-01", strength: "medium" as const };

async function fonts(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((_, i) => pageFonts(doc, i));
}

describe.each(Object.entries(FIXTURES))("Hebrew fidelity %s", (_name, opts) => {
  it("preflight/sanitize keeps text and fonts, page by page and in order", async () => {
    const original = await makeHebrewPdf(opts);
    const pf = await preflightPdf(original, { maxSizeBytes: 1e8 });
    expect(pf.ok).toBe(true);
    if (!pf.ok) return;
    if (opts.active) expect(pf.sanitizedBytes).toBeDefined();
    const out = pf.sanitizedBytes ?? original;
    expect(await pageTexts(out)).toEqual(await pageTexts(original));
    expect(await fonts(out)).toEqual(await fonts(original));
    expect(fontsWithToUnicode(await PDFDocument.load(out))).toEqual(fontsWithToUnicode(await PDFDocument.load(original)));
  });

  it("page subset keeps the chosen pages' text and fonts", async () => {
    const original = await makeHebrewPdf(opts);
    const total = (await PDFDocument.load(original)).getPageCount();
    const pick = total > 1 ? [total, 1] : [1];
    const sub = await createPageSubsetPdf(original, pick);
    const before = await pageTexts(original);
    const beforeFonts = await fonts(original);
    expect(await pageTexts(sub)).toEqual(pick.map((p) => before[p - 1]));
    expect(await fonts(sub)).toEqual(pick.map((p) => beforeFonts[p - 1]));
  });

  it("the stamp adds only its own ASCII text: Hebrew text and fonts are unchanged", async () => {
    const original = await makeHebrewPdf(opts);
    const stamped = await stampFirstPage(original, STAMP);
    const before = await pageTexts(original);
    const after = await pageTexts(stamped);
    expect(after.map(nonAscii)).toEqual(before.map(nonAscii));
    expect(after[0]!.join(" ")).toContain("SV42");
    const f0 = await fonts(original);
    const f1 = await fonts(stamped);
    f0.forEach((set, i) => expect(f1[i]).toEqual(expect.arrayContaining(set)));
    expect(fontsWithToUnicode(await PDFDocument.load(stamped))).toEqual(fontsWithToUnicode(await PDFDocument.load(original)));
  });

  it.each([
    ["left", "fill"],
    ["right", "keep"],
  ] as const)("booklet (%s binding, %s fit) then stamp: each sheet side holds exactly its two source pages' Hebrew characters", async (bindingSide, fit) => {
    const original = await makeHebrewPdf(opts);
    const built = await padAndImposeBooklet(original, { paperSize: "letter", bindingSide, fit });
    const stamped = await stampFirstPage(built.bytes, STAMP);
    const src = (await pageTexts(original)).map(nonAscii);
    const padded = [...src, ...Array(built.paddedPages - src.length).fill("")] as string[];
    const out = (await pageTexts(stamped)).map(nonAscii);
    const sheets = bookletPageOrder(built.paddedPages);
    const expected = sheets.flatMap((s) => [s.front, s.back]).map(([l, r]) => chars(padded[l - 1]! + padded[r - 1]!));
    expect(out.map(chars)).toEqual(expected);
    const srcFonts = new Set((await fonts(original)).flat());
    const outFonts = new Set((await fonts(stamped)).flat());
    for (const f of srcFonts) expect(outFonts.has(f)).toBe(true);
  });
});
