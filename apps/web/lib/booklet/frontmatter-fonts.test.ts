import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("server-only", () => ({}));
import { PDFDocument } from "pdf-lib";
import { pageFonts } from "@/test/hebrew-fixtures";
import { assembleBooklet, BuilderError } from "./assemble";
import { addFrontMatter, drawBackPageText, frontMatterPageCount, type FrontMatterInput } from "./frontmatter";
import { EZRA_SIL_REGULAR_BASE64 } from "@printio/pdf/fonts/ezra-sil-regular";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@printio/pdf/fonts/david-libre-regular";
import { loadBundledEnglishFont } from "@printio/pdf/fonts/english";

// Ezra SIL stands in for a heavy Hebrew title font, David Libre for an uploaded body font; EB Garamond is a bundled English font.
const EZRA = new Uint8Array(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64"));
const DAVID = new Uint8Array(Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64"));
const saved = async (doc: PDFDocument) => PDFDocument.load(await doc.save());
const names = (doc: PDFDocument, page: number) => pageFonts(doc, page).join(" ");
const SIZE = { width: 396, height: 612 };
const front = (over: Partial<FrontMatterInput> = {}): FrontMatterInput => ({
  title: "ליקוטי שיחות",
  description: "",
  direction: "rtl",
  entries: [{ title: "שיחה א", startPage: 3 }],
  credits: [],
  cover: true,
  contents: true,
  size: SIZE,
  ...over,
});
const build = async (input: FrontMatterInput) => {
  const doc = await PDFDocument.create();
  await addFrontMatter(doc, input);
  return saved(doc);
};

describe("front matter title font", () => {
  it("draws the Hebrew cover title, contents heading and contents titles in the title font; page numbers stay in David Libre", async () => {
    const doc = await build(front({ titleFont: EZRA }));
    expect(names(doc, 0)).toMatch(/Ezra/i);
    expect(names(doc, 0)).not.toMatch(/DavidLibre/i);
    expect(names(doc, 1)).toMatch(/Ezra/i);
    expect(names(doc, 1)).toMatch(/DavidLibre/i); // the page number
  });

  it("without a title font the titles use the body Hebrew font, and David Libre when there is none", async () => {
    expect(names(await build(front({ hebrewFont: EZRA })), 0)).toMatch(/Ezra/i);
    const plain = await build(front());
    expect(names(plain, 0)).toMatch(/DavidLibre/i);
    expect(names(plain, 0)).not.toMatch(/Ezra/i);
  });

  it("keeps the body Hebrew font for the description even when a title font is given", async () => {
    const doc = await build(front({ description: "מבחר שיחות לשבת", hebrewFont: DAVID, titleFont: EZRA }));
    expect(names(doc, 0)).toMatch(/Ezra/i);
    expect(names(doc, 0)).toMatch(/DavidLibre-Regular/i);
  });

  it("uses it only for Hebrew: Latin letters in a title stay in the English bold font", async () => {
    const doc = await build(front({ title: "Likkutei Sichos", direction: "ltr", entries: [{ title: "Vayera", startPage: 3 }], titleFont: EZRA }));
    expect(names(doc, 0)).not.toMatch(/Ezra/i);
    expect(names(doc, 1)).not.toMatch(/Ezra/i);
    const mixed = await build(front({ title: "ליקוטי שיחות - Likkutei Sichos", titleFont: EZRA }));
    expect(names(mixed, 0)).toMatch(/Ezra/i);
    expect(names(mixed, 0)).toMatch(/DavidLibre-Bold/i);
  });

  it("counts the same pages whether measured or drawn", async () => {
    const input = front({ titleFont: EZRA, entries: Array.from({ length: 40 }, (_, i) => ({ title: `שיחה ${i + 1} - ליקוטי שיחות חלק ה על פרשת וירא`, startPage: i + 5 })) });
    const counted = await frontMatterPageCount(input);
    const doc = await PDFDocument.create();
    expect(await addFrontMatter(doc, input)).toBe(counted);
    expect(counted).toBeGreaterThan(2);
  });
});

describe("front matter English font", () => {
  it("draws Latin text in the given font instead of David Libre, and falls back to the regular face when there is no bold", async () => {
    const garamond = (await loadBundledEnglishFont("eb-garamond"))!;
    const input = front({ title: "Likkutei Sichos", description: "Selected talks", direction: "ltr", entries: [{ title: "Vayera", startPage: 3 }], credits: ["Mafteiach"] });
    const both = await build({ ...input, latinFont: garamond });
    for (const i of [0, 1]) {
      expect(names(both, i), `page ${i}`).toMatch(/EBGaramond/i);
      expect(names(both, i), `page ${i}`).not.toMatch(/DavidLibre/i);
    }
    expect(names(both, 0)).toMatch(/EBGaramond-Bold/i);
    const regularOnly = await build({ ...input, latinFont: { regular: garamond.regular } });
    expect(names(regularOnly, 0)).toMatch(/EBGaramond-Regular/i);
    expect(names(regularOnly, 0)).not.toMatch(/Bold/i);
  });

  it("never draws Hebrew in it: Hebrew keeps its own font (David Libre when no Hebrew font was given)", async () => {
    const garamond = (await loadBundledEnglishFont("eb-garamond"))!;
    const doc = await build(front({ latinFont: garamond }));
    expect(names(doc, 0)).toMatch(/DavidLibre/i);
    expect(names(doc, 0)).not.toMatch(/EBGaramond/i);
    const withFont = await build(front({ latinFont: garamond, hebrewFont: EZRA, description: "מבחר שיחות" }));
    expect(names(withFont, 0)).toMatch(/Ezra/i);
    expect(names(withFont, 0)).not.toMatch(/DavidLibre/i);
    expect(names(withFont, 1)).toMatch(/EBGaramond/i); // the page number
  });

  it("puts the back page text in it too", async () => {
    const garamond = (await loadBundledEnglishFont("source-serif-4"))!;
    const doc = await PDFDocument.create();
    doc.addPage([SIZE.width, SIZE.height]);
    await drawBackPageText(doc, { credits: ["Mafteiach"], sponsorLine: "In honor of a friend", direction: "ltr", size: SIZE, latinFont: garamond });
    expect(names(await saved(doc), 0)).toMatch(/SourceSerif4/i);
    expect(names(await saved(doc), 0)).not.toMatch(/DavidLibre/i);
  });

  it("refuses a font that cannot be read, with a plain message and no silent fallback", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const doc = await PDFDocument.create();
    await expect(addFrontMatter(doc, front({ latinFont: { regular: junk } }))).rejects.toThrow(/could not be read/);
    await expect(addFrontMatter(await PDFDocument.create(), front({ titleFont: junk }))).rejects.toThrow(/could not be read/);
    await expect(addFrontMatter(await PDFDocument.create(), front({ latinFont: { regular: DAVID, bold: new Uint8Array([79, 84, 84, 79, 0, 0]) } }))).rejects.toThrow(/could not be read/);
  });
});

describe("booklet builder fonts", () => {
  it("passes both fonts to the cover, contents and back page, and refuses unreadable ones as a BuilderError", async () => {
    const source = await PDFDocument.create();
    source.addPage([396, 612]);
    const bytes = await source.save();
    const garamond = (await loadBundledEnglishFont("eb-garamond"))!;
    const base = { title: "ליקוטי שיחות - Likkutei Sichos", description: "", direction: "rtl" as const, cover: true, contents: true, sponsorLine: "In honor of a friend", sources: [{ title: "Vayera", bytes, credit: "Mafteiach" }] };
    const r = await assembleBooklet({ ...base, titleFont: EZRA, latinFont: garamond });
    const doc = await PDFDocument.load(r.bytes);
    expect(r.backPage).toBe(true);
    expect(names(doc, 0)).toMatch(/Ezra/i);
    expect(names(doc, 0)).toMatch(/EBGaramond/i);
    expect(names(doc, doc.getPageCount() - 1)).toMatch(/EBGaramond/i);
    // the Hebrew "Courtesy of" word is Hebrew, so David Libre still draws that; the English text is in the English font
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(assembleBooklet({ ...base, titleFont: junk })).rejects.toBeInstanceOf(BuilderError);
    await expect(assembleBooklet({ ...base, latinFont: { regular: junk } })).rejects.toThrow(/could not be read/);
  });
});
