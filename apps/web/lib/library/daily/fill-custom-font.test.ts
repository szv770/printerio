import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@/lib/booklet/fonts/david-libre-regular";
import { EZRA_SIL_REGULAR_BASE64 } from "@/lib/booklet/fonts/ezra-sil-regular";
import { nonAscii, pageFonts, pageTexts } from "@/test/hebrew-fixtures";
import { buildFilledPdf, findMissingMarks, type FillInput } from "./fill";
import type { StudySection } from "./page";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

// Stand-ins for an "uploaded" font: David Libre has letters and vowel points but no cantillation marks; Ezra SIL has all of them.
const DAVID = new Uint8Array(Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64"));
const EZRA = new Uint8Array(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64"));

const WITH_TROP = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם";
const NO_TROP = "בְּרֵאשִׁית בָּרָא אֱלֹהִים";
const BARE = "בראשית ברא אלהים";
const sections = (he: string): StudySection[] => [{ heading: "", blocks: [{ kind: "verse", he, en: "In the beginning" }] }];
const input = (he: string, over: Partial<FillInput> = {}): FillInput => ({
  title: "Study",
  items: [{ title: "Chumash", sections: sections(he) }],
  language: "he",
  page: { width: 396, height: 612 },
  margin: 28,
  ...over,
});
const drawnHebrew = (r: Awaited<ReturnType<typeof buildFilledPdf>>) => r.plan.pages.flat().filter((o) => o.font === "hebrew").map((o) => o.logical).join(" ");

describe("buildFilledPdf with an uploaded Hebrew font", () => {
  it("reports cantillation the font lacks, but still draws and extracts the Hebrew unchanged", async () => {
    const custom = await buildFilledPdf(input(WITH_TROP, { hebrewFont: DAVID }));
    expect(custom.missingMarks).toEqual({ vowels: false, cantillation: true });
    expect(custom.strippedMarks).toBe(false);
    expect(drawnHebrew(custom)).toContain(WITH_TROP);
    const reference = await buildFilledPdf(input(WITH_TROP));
    // Same letters and vowel points come back out of the PDF as with the font that has every mark.
    const strip = (s: string) => s.replace(/[֑-ֽ֯]/g, "");
    const letters = async (bytes: Uint8Array) => strip(nonAscii((await pageTexts(bytes)).flat()));
    // Compare the characters, not their order: glyphs are placed one by one, and a reader may list them in a different order per font.
    const sorted = async (bytes: Uint8Array) => [...(await letters(bytes))].sort().join("");
    expect(await sorted(custom.bytes)).toBe(await sorted(reference.bytes));
    expect((await letters(custom.bytes)).length).toBeGreaterThan(20);
    // and it is the uploaded font that is embedded, not Ezra SIL
    const doc = await PDFDocument.load(custom.bytes);
    expect(pageFonts(doc, 0).join(" ")).toMatch(/DavidLibre/i);
    expect(pageFonts(doc, 0).join(" ")).not.toMatch(/Ezra/i);
  });

  it("reports missing vowels (and keeps cantillation separate) from a font's character set; the bundled fonts all have the vowels", async () => {
    const r = await buildFilledPdf(input(WITH_TROP));
    const hebrewOnly = (cps: number[]) => ({ getCharacterSet: () => [...new Set([...Array.from(BARE).map((c) => c.codePointAt(0)!), ...cps])] });
    // letters only: both kinds missing
    expect(findMissingMarks(r.plan, hebrewOnly([]))).toEqual({ vowels: true, cantillation: true });
    // letters + vowel points, no cantillation
    const vowels = [0x5b0, 0x5b1, 0x5b2, 0x5b3, 0x5b4, 0x5b5, 0x5b6, 0x5b7, 0x5b8, 0x5b9, 0x5ba, 0x5bb, 0x5bc, 0x5c1, 0x5c2, 0x5c7];
    expect(findMissingMarks(r.plan, hebrewOnly(vowels))).toEqual({ vowels: false, cantillation: true });
    // letters + cantillation, no vowels
    const trop = Array.from({ length: 0xaf - 0x91 + 1 }, (_, i) => 0x591 + i);
    expect(findMissingMarks(r.plan, hebrewOnly(trop))).toEqual({ vowels: true, cantillation: false });
  });

  it("reports nothing missing for Ezra SIL passed explicitly, even with vowels and cantillation", async () => {
    const r = await buildFilledPdf(input(WITH_TROP, { hebrewFont: EZRA }));
    expect(r.missingMarks).toEqual({ vowels: false, cantillation: false });
    expect(drawnHebrew(r)).toContain(WITH_TROP);
  });

  it("reports nothing missing when the Hebrew has no marks", async () => {
    const r = await buildFilledPdf(input(BARE, { hebrewFont: DAVID }));
    expect(r.missingMarks).toEqual({ vowels: false, cantillation: false });
  });

  it("behaves exactly as before when no font is given", async () => {
    const r = await buildFilledPdf(input(WITH_TROP));
    expect(r.missingMarks).toEqual({ vowels: false, cantillation: false });
    const doc = await PDFDocument.load(r.bytes);
    expect(pageFonts(doc, 0).join(" ")).toMatch(/Ezra/i);
  });

  it("throws a plain message for a font that cannot be read, with no silent fallback", async () => {
    await expect(buildFilledPdf(input(WITH_TROP, { hebrewFont: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }))).rejects.toThrow(/That font could not be read/);
    await expect(buildFilledPdf(input(WITH_TROP, { hebrewFont: new Uint8Array(0) }))).rejects.toThrow(/That font could not be read/);
  });
});
