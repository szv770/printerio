import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { EZRA_SIL_REGULAR_BASE64 } from "@printio/pdf/fonts/ezra-sil-regular";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@printio/pdf/fonts/david-libre-regular";
import { loadBundledEnglishFont } from "@printio/pdf/fonts/english";
import { pageFonts, pageTexts } from "@/test/hebrew-fixtures";
import { buildFilledPdf, type FillInput } from "./fill";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

// David Libre stands in for a heavy Hebrew title font (it is told apart from Ezra SIL, the body font, by name).
const TITLE = new Uint8Array(Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64"));
const EZRA = new Uint8Array(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64"));
const input = (over: Partial<FillInput> = {}): FillInput => ({
  title: "Daily Study - 14 Cheshvan",
  titleHe: "לימוד יומי - י״ד חשון",
  items: [
    { title: "Chumash - Bereishit", titleHe: "חומש - פרשת בראשית", sections: [{ heading: "", blocks: [{ kind: "verse", he: "בראשית ברא אלהים", en: "In the beginning", num: "1" }] }] },
    { title: "Tehillim", sections: [{ heading: "", blocks: [{ kind: "verse", he: "אשרי האיש", en: "Happy is the man", num: "2" }] }] },
  ],
  language: "both",
  page: { width: 396, height: 612 },
  margin: 28,
  ...over,
});
const headings = (r: Awaited<ReturnType<typeof buildFilledPdf>>) => r.plan.pages.flat().filter((o) => o.role === "heading");
const fontsOf = async (bytes: Uint8Array) => pageFonts(await PDFDocument.load(bytes), 0).join(" ");

describe("Hebrew titles", () => {
  it("Hebrew-only: draws only the Hebrew title, right-to-left, in the title font; falls back to English when an item has none", async () => {
    const r = await buildFilledPdf(input({ language: "he", titleFont: TITLE, hebrewFont: EZRA }));
    const h = headings(r);
    expect(h.map((o) => o.logical)).toEqual(["לימוד יומי - י״ד חשון", "חומש - פרשת בראשית", "Tehillim"]);
    expect(h[0]!.font).toBe("title");
    expect(h[0]!.dir).toBe("rtl");
    expect(h[2]!.font).toBe("bold");
    // the title font is a different embedded font from the body Hebrew font
    expect(await fontsOf(r.bytes)).toMatch(/DavidLibre/i);
  });

  it("English-only: only the English titles, whatever Hebrew titles were given", async () => {
    const r = await buildFilledPdf(input({ language: "en", titleFont: TITLE }));
    expect(headings(r).map((o) => o.logical)).toEqual(["Daily Study - 14 Cheshvan", "Chumash - Bereishit", "Tehillim"]);
    expect(r.plan.pages.flat().some((o) => o.font === "title")).toBe(false);
  });

  it("Both: the Hebrew title large with the English title smaller directly beneath it, in the same place", async () => {
    const r = await buildFilledPdf(input({ titleFont: TITLE }));
    const h = headings(r);
    expect(h.map((o) => o.logical)).toEqual(["לימוד יומי - י״ד חשון", "Daily Study - 14 Cheshvan", "חומש - פרשת בראשית", "Chumash - Bereishit", "Tehillim"]);
    const [heB, enB, heI, enI] = h;
    for (const [he, en] of [[heB!, enB!], [heI!, enI!]] as const) {
      expect(he.size).toBeGreaterThan(en.size);
      expect(he.y).toBeGreaterThan(en.y);
      expect(he.y - en.y).toBeLessThan(he.size * 2);
      expect(he.font).toBe("title");
      expect(en.font).toBe("bold");
    }
    // the booklet title is centred, both lines
    for (const o of [heB!, enB!]) expect(Math.abs(o.x + o.width / 2 - 198)).toBeLessThan(0.5);
    // an item title keeps the English title's flush-left place for both lines
    expect(heI!.x).toBeCloseTo(enI!.x, 5);
  });

  it("uses the body Hebrew font when there is no title font", async () => {
    const r = await buildFilledPdf(input({ language: "he" }));
    expect(headings(r)[0]!.font).toBe("hebrew");
    expect(await fontsOf(r.bytes)).not.toMatch(/DavidLibre-Regular/i); // only the English "Tehillim" row is in David Libre (bold)
  });

  it("still fills whole sheets with the taller title rows, and Latin letters inside a Hebrew title stay in the English bold font", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Item ${i}`, titleHe: `פרק ${i}`, sections: [{ heading: "", blocks: [{ kind: "verse" as const, he: "בראשית ברא אלהים את השמים ואת הארץ ".repeat(8), en: "In the beginning God created the heaven and the earth. ".repeat(8), num: String(i) }] }] }));
    const r = await buildFilledPdf(input({ items: many, titleFont: TITLE, hebrewFont: EZRA, titleHe: "לימוד - Study" }));
    expect(r.pages % 4).toBe(0);
    expect(r.pages).toBe(r.targetPages);
    expect(r.lastPageFill).toBeGreaterThan(0.5);
    const mixed = headings(r)[0]!;
    expect(mixed.logical).toBe("לימוד - Study");
    expect(mixed.font).toBe("title");
    expect(await fontsOf(r.bytes)).toMatch(/DavidLibre-Bold/i); // the English word
    const text = (await pageTexts(r.bytes))[0]!.join("");
    expect(text).toContain("Study");
  });
});

describe("English font", () => {
  const study = (over: Partial<FillInput> = {}) => input({ language: "en", titleHe: undefined, ...over });

  it("draws English body, titles, credit and numbers in the given font instead of David Libre", async () => {
    const garamond = (await loadBundledEnglishFont("eb-garamond"))!;
    const r = await buildFilledPdf(study({ latinFont: garamond, credit: "With thanks to the source" }));
    const names = await fontsOf(r.bytes);
    expect(names).toMatch(/EBGaramond-Regular/i);
    expect(names).toMatch(/EBGaramond-Bold/i);
    expect(names).not.toMatch(/DavidLibre/i);
    expect(r.plan.pages.flat().filter((o) => o.role === "heading").every((o) => o.bold)).toBe(true);
  });

  it("uses the regular face for bold rows when there is no bold file", async () => {
    const garamond = (await loadBundledEnglishFont("source-serif-4"))!;
    const r = await buildFilledPdf(study({ latinFont: { regular: garamond.regular } }));
    const names = await fontsOf(r.bytes);
    expect(names).toMatch(/SourceSerif4-Regular/i);
    expect(names).not.toMatch(/Bold/i);
    // the rows are still planned as headings in the same place
    expect(headings(r).length).toBe(3);
  });

  it("never draws Hebrew in it: Hebrew words inside English text use the Hebrew font", async () => {
    const garamond = (await loadBundledEnglishFont("libre-baskerville"))!;
    const withHebrew = study({ latinFont: garamond, hebrewFont: EZRA, items: [{ title: "Study", sections: [{ heading: "", blocks: [{ kind: "verse", he: "", en: "The word בראשית means “in the beginning”.", num: "1" }] }] }] });
    const r = await buildFilledPdf(withHebrew);
    expect(await fontsOf(r.bytes)).toMatch(/Ezra/i);
    const text = (await pageTexts(r.bytes))[0]!.join("");
    expect(text).toContain("means");
    expect([...text].filter((c) => /[א-ת]/.test(c)).sort().join("")).toBe([..."בראשית"].sort().join(""));
  });

  it("refuses an English font that cannot be read, with a plain message", async () => {
    await expect(buildFilledPdf(study({ latinFont: { regular: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) } }))).rejects.toThrow(/could not be read/);
  });
});
