import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { parseStudyPage, type StudySection } from "@printio/shared/library/daily/page";
import { DAVID_LIBRE_BOLD_BASE64 } from "@printio/pdf/fonts/david-libre-bold";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@printio/pdf/fonts/david-libre-regular";
import { EZRA_SIL_REGULAR_BASE64 } from "@printio/pdf/fonts/ezra-sil-regular";
import { loadBundledEnglishFont } from "@printio/pdf/fonts/english";
import { pageFonts } from "@/test/hebrew-fixtures";
import { buildFilledPdf, chooseHebrewShare, COLUMN_SHARES, type FillInput, type ParaWords, type SharePair } from "./fill";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

const fixture = (name: string) => readFileSync(join(__dirname, "..", "..", "..", "..", "..", "packages", "shared", "src", "library", "daily", "fixtures", name), "utf8");
const HALF_LETTER = { width: 396, height: 612 };
const chumash = parseStudyPage(fixture("study-chumash.html"), "chumash").sections;
const rambam = parseStudyPage(fixture("study-rambam3.html"), "rambam3").sections;
const base = (sections: StudySection[], over: Partial<FillInput> = {}): FillInput => ({
  title: "Daily Study",
  titleHe: "לימוד יומי",
  items: [{ title: "Chumash with Rashi - Bereishit", titleHe: "חומש - פרשת בראשית", sections }],
  language: "both",
  page: HALF_LETTER,
  margin: 28,
  ...over,
});
const body = (r: Awaited<ReturnType<typeof buildFilledPdf>>) => r.plan.pages.flat().filter((o) => o.role === "body");
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** A paragraph of `n` words, each `w` wide, with a space of 3. */
const para = (n: number, w = 30): ParaWords => ({ words: Array.from({ length: n }, () => w), space: 3 });
const row = (he: number, en: number): SharePair => ({ he: [para(he)], en: [para(en)], weight: 1 });

describe("chooseHebrewShare: how the two columns share the width", () => {
  it("gives English more room when the English is longer", () => {
    const share = chooseHebrewShare([row(20, 45), row(12, 30), row(30, 60)], 324);
    expect(share).toBeLessThan(0.5);
    expect(share).toBeGreaterThanOrEqual(0.3);
  });

  it("stays even when the two languages are alike, and never gives Hebrew more than half", () => {
    expect(chooseHebrewShare([row(30, 30), row(12, 12)], 324)).toBe(0.5);
    expect(chooseHebrewShare([row(60, 10)], 324)).toBe(0.5);
    expect(chooseHebrewShare([], 324)).toBe(0.5);
  });

  it("never gives Hebrew less than 30%, however long the English", () => {
    const tiny = chooseHebrewShare([{ he: [para(2, 7)], en: [para(400, 7)], weight: 1 }], 324);
    expect(tiny).toBeGreaterThanOrEqual(0.3);
    expect(tiny).toBeLessThanOrEqual(0.33);
    for (const en of [10, 40, 80, 160, 320]) {
      const share = chooseHebrewShare([row(20, en)], 324);
      expect(share).toBeGreaterThanOrEqual(0.3);
      expect(share).toBeLessThanOrEqual(0.5);
    }
  });

  it("the three fixed choices are exact: Even 50/50, Wider English 40/60, Much wider English 33/67", () => {
    const pairs = [row(20, 45)];
    expect(chooseHebrewShare(pairs, 324, "even")).toBe(0.5);
    expect(chooseHebrewShare(pairs, 324, "wider")).toBe(0.4);
    expect(chooseHebrewShare(pairs, 324, "much")).toBe(0.33);
    expect(COLUMN_SHARES).toEqual({ even: 0.5, wider: 0.4, much: 0.33 });
  });

  it("the share it picks is never taller than an even split", () => {
    const pairs = [row(20, 45), row(8, 33), row(15, 50)];
    const height = (s: number) => {
      const lines = (p: ParaWords, col: number) => Math.ceil((p.words.length * 33) / col);
      return pairs.reduce((sum, p) => sum + Math.max(lines(p.he[0]!, s * 324), lines(p.en[0]!, (1 - s) * 324)), 0);
    };
    expect(height(chooseHebrewShare(pairs, 324))).toBeLessThanOrEqual(height(0.5));
  });
});

describe("column widths on the page", () => {
  const inner = HALF_LETTER.width - 2 * 28 - 16; // the two columns without the space between them
  const edges = (r: Awaited<ReturnType<typeof buildFilledPdf>>) => {
    const verses = body(r).filter((o) => o.size === r.fontSize);
    return { hebrewRight: Math.max(...verses.filter((o) => o.dir === "rtl").map((o) => o.x + o.width)), englishLeft: Math.min(...verses.filter((o) => o.dir === "ltr").map((o) => o.x)) };
  };

  it("Automatic measures the study's text: English, the longer, gets the wider column, within 30 to 50%", async () => {
    const r = await buildFilledPdf(base(rambam, { columns: "auto" }));
    expect(r.plan.shares).toHaveLength(1);
    const share = r.plan.shares[0]!;
    expect(share).toBeLessThan(0.5);
    expect(share).toBeGreaterThanOrEqual(0.3);
    const { hebrewRight, englishLeft } = edges(r);
    expect(hebrewRight).toBeLessThanOrEqual(28 + inner * share + 0.5);
    expect(englishLeft).toBeCloseTo(28 + inner * share + 16, 1);
    expect(englishLeft).toBeLessThan(HALF_LETTER.width / 2);
  });

  it("Automatic saves room: never more pages than an even split, and a bigger or equal type size", async () => {
    const many = Array.from({ length: 6 }, () => rambam).flat();
    const auto = await buildFilledPdf(base(many, { columns: "auto" }));
    const even = await buildFilledPdf(base(many, { columns: "even" }));
    expect(auto.pages).toBeLessThanOrEqual(even.pages);
    if (auto.pages === even.pages) expect(auto.fontSize).toBeGreaterThanOrEqual(even.fontSize);
  });

  it("each study gets its own share", async () => {
    const r = await buildFilledPdf(base(rambam, { columns: "auto", items: [{ title: "A", sections: rambam }, { title: "B", sections: [{ heading: "", blocks: [{ kind: "verse", he: "אבג דהו זחט יכל מנס עפצ קרשת ".repeat(12), en: "Short." }] }] }] }));
    expect(r.plan.shares).toHaveLength(2);
    expect(r.plan.shares[1]).toBe(0.5);
    expect(r.plan.shares[0]).toBeLessThan(0.5);
  });

  it.each([
    ["even", 0.5],
    ["wider", 0.4],
    ["much", 0.33],
  ] as const)("the fixed choice %s puts the English column at exactly %f, and Rashi's box follows the same split", async (columns, share) => {
    const r = await buildFilledPdf(base(chumash, { columns }));
    expect(r.plan.shares).toEqual([share]);
    const { englishLeft } = edges(r);
    expect(englishLeft).toBeCloseTo(28 + inner * share + 16, 1);
    // Rashi (smaller, inside the shaded box with its 4pt padding) splits at the same share of its own width.
    const rashi = body(r).filter((o) => o.size < r.fontSize && o.dir === "ltr");
    expect(rashi.length).toBeGreaterThan(0);
    expect(Math.min(...rashi.map((o) => o.x))).toBeCloseTo(28 + 4 + (inner - 8) * share + 16, 1);
    expect(r.plan.rects.flat().length).toBeGreaterThan(0);
  });

  it("left alone, the split is even (as it always was)", async () => {
    const r = await buildFilledPdf(base(rambam));
    expect(r.plan.shares).toEqual([0.5]);
  });

  it("a one-language booklet keeps the full width whatever the choice", async () => {
    for (const language of ["he", "en"] as const) {
      const r = await buildFilledPdf(base(rambam, { language, columns: "much" }));
      expect(r.plan.shares).toEqual([]);
      const widest = Math.max(...body(r).map((o) => o.width));
      expect(widest).toBeGreaterThan(HALF_LETTER.width * 0.75);
    }
  });
});

describe("the front page, the footer and the look", () => {
  const cover = { dateEn: "Monday, November 2, 2026", dateHe: "יום שני, כ״ב חשון תשפ״ז", contents: [{ label: "Monday", text: "Chumash with Rashi, Tanya, Rambam (1 perek)", labelHe: "יום שני", textHe: "חומש עם רש״י, תניא, רמב״ם (פרק אחד)" }] };
  const withCover = (over: Partial<FillInput> = {}) => base(chumash, { cover, footer: { text: cover.dateEn, textHe: cover.dateHe }, credit: "Thank you.", ...over });
  const coverText = (r: Awaited<ReturnType<typeof buildFilledPdf>>) => r.plan.pages[0]!.map((o) => o.logical);

  it("the first page is the front page: title, dates and what is inside, in both languages, and the text starts on page 2", async () => {
    const r = await buildFilledPdf(withCover());
    const text = coverText(r);
    expect(r.plan.pages[0]!.every((o) => o.role === "cover")).toBe(true);
    for (const t of ["לימוד יומי", "Daily Study", cover.dateHe, cover.dateEn, "In this booklet", "בחוברת זו", "Monday:", "יום שני:", cover.contents[0]!.text, cover.contents[0]!.textHe]) expect(text).toContain(t);
    expect(r.plan.pages[1]!.some((o) => o.role === "heading" && o.logical === "חומש - פרשת בראשית")).toBe(true);
    // the booklet's title is on the front page only
    expect(r.plan.pages.slice(1).flat().some((o) => o.logical === "Daily Study")).toBe(false);
    expect(r.pages % 4).toBe(0);
    expect(r.pages).toBe(r.targetPages);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(r.pages);
  });

  it("the front page follows the language: Hebrew names for Hebrew, English for English", async () => {
    const he = coverText(await buildFilledPdf(withCover({ language: "he" })));
    expect(he).toEqual(expect.arrayContaining(["לימוד יומי", cover.dateHe, "בחוברת זו", "יום שני:", cover.contents[0]!.textHe]));
    expect(he.join(" ")).not.toMatch(/[A-Za-z]{3}/);
    const en = coverText(await buildFilledPdf(withCover({ language: "en" })));
    expect(en).toEqual(expect.arrayContaining(["Daily Study", cover.dateEn, "In this booklet", "Monday:", cover.contents[0]!.text]));
    expect(en.join(" ")).not.toMatch(/[א-ת]/);
  });

  it("the list of what is inside has no page numbers, stays inside the page, and a full week still fits", async () => {
    const week = Array.from({ length: 7 }, (_, i) => ({ label: `Day ${i + 1}`, text: "Chumash with Rashi, Tanya, Hayom Yom, Rambam (3 perakim), Rambam (1 perek)", labelHe: "יום שני", textHe: "חומש עם רש״י, תניא, היום יום, רמב״ם (ג׳ פרקים), רמב״ם (פרק אחד)" }));
    const r = await buildFilledPdf(withCover({ cover: { ...cover, contents: week } }));
    const ops = r.plan.pages[0]!;
    expect(ops.filter((o) => o.logical === "יום שני:")).toHaveLength(7);
    expect(ops.filter((o) => o.logical !== cover.dateEn && (/^\d+$/.test(o.logical.trim()) || /\.{3,}|\s\d+$/.test(o.logical))).map((o) => o.logical)).toEqual([]);
    for (const o of ops) {
      expect(o.x).toBeGreaterThanOrEqual(28);
      expect(o.x + o.width).toBeLessThanOrEqual(HALF_LETTER.width - 28);
      expect(o.y).toBeGreaterThanOrEqual(28);
      expect(o.y).toBeLessThanOrEqual(HALF_LETTER.height - 28);
    }
    // an entry is never broken in the middle ("Rambam (1" / "perek)")
    expect(ops.filter((o) => /\(\d*$/.test(o.logical.trim())).map((o) => o.logical)).toEqual([]);
  });

  it("every page of text has a footer with the date and the page number (outer edge), and the front page has none", async () => {
    const r = await buildFilledPdf(withCover({ items: [{ title: "Rambam", sections: Array.from({ length: 5 }, () => rambam).flat() }] }));
    expect(r.plan.pages[0]!.some((o) => o.role === "footer")).toBe(false);
    r.plan.pages.forEach((ops, i) => {
      if (i === 0 || ops.length === 0) return;
      const foot = ops.filter((o) => o.role === "footer");
      const number = foot.find((o) => o.logical === String(i + 1));
      expect(number, `page ${i + 1}`).toBeDefined();
      expect(foot.map((o) => o.logical)).toEqual(expect.arrayContaining([cover.dateEn, cover.dateHe]));
      // page 2 is a left-hand page of a left-bound booklet: its number is at the left; page 3's at the right
      if ((i + 1) % 2 === 0) expect(number!.x).toBeCloseTo(28, 1);
      else expect(number!.x + number!.width).toBeCloseTo(HALF_LETTER.width - 28, 1);
      // the text stays above the footer
      const lowestText = Math.min(...ops.filter((o) => o.role !== "footer").map((o) => o.y));
      expect(lowestText).toBeGreaterThan(Math.max(...foot.map((o) => o.y)) + 8);
    });
    // a Hebrew booklet binds on the right, so page 2's number is at the right
    const he = await buildFilledPdf(withCover({ language: "he" }));
    const two = he.plan.pages[1]!.find((o) => o.role === "footer" && o.logical === "2")!;
    expect(two.x + two.width).toBeCloseTo(HALF_LETTER.width - 28, 1);
    expect(he.plan.pages[1]!.filter((o) => o.role === "footer").map((o) => o.logical)).toContain(cover.dateHe);
  });

  it("the credit is still the last thing in the booklet, and the pages are still filled", async () => {
    const r = await buildFilledPdf(withCover({ items: [{ title: "Rambam", sections: Array.from({ length: 6 }, () => rambam).flat() }] }));
    const lastPage = r.plan.pages.filter((p) => p.length > 0).at(-1)!;
    expect(lastPage.at(-1)!.role).toBe("credit");
    expect(r.pages).toBe(r.targetPages);
    expect(r.lastPageFill).toBeGreaterThan(0.5);
    expect(r.pagesAtMinSize).toBeGreaterThan(r.targetPages - 4);
  });

  it("no heading is left alone at the foot of a page", async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ title: `Study ${i}`, titleHe: `לימוד ${i}`, groupTitle: i % 3 === 0 ? `Day ${i / 3 + 1}` : undefined, sections: [{ heading: `Chapter ${i}`, blocks: rambam.flatMap((s) => s.blocks) }] }));
    const r = await buildFilledPdf(withCover({ items }));
    r.plan.pages.forEach((ops) => {
      const text = ops.filter((o) => o.role !== "footer");
      if (text.length === 0) return;
      const lowest = text.reduce((a, b) => (b.y < a.y ? b : a));
      expect(lowest.role).not.toBe("heading");
    });
    // a study's title has a thin rule under it, a day's heading a short rule with an ornament
    expect(r.plan.rules.slice(1).flat().length).toBeGreaterThan(9);
    expect(r.plan.diamonds.slice(1).flat()).toHaveLength(3);
  });
});

describe("fonts by job", () => {
  const rashiBlocks = chumash;

  it("titles in the title font, body in the body font, Rashi in its own Hebrew and English fonts", async () => {
    const garamond = (await loadBundledEnglishFont("eb-garamond"))!;
    const baskerville = (await loadBundledEnglishFont("libre-baskerville"))!;
    const r = await buildFilledPdf(
      base(rashiBlocks, {
        hebrewFont: bytes(EZRA_SIL_REGULAR_BASE64),
        titleFont: bytes(DAVID_LIBRE_BOLD_BASE64),
        rashiFont: bytes(DAVID_LIBRE_REGULAR_BASE64),
        latinFont: garamond,
        latinRashiFont: baskerville.regular,
      }),
    );
    const ops = r.plan.pages.flat();
    const hebrewRashi = ops.filter((o) => o.font === "rashi");
    const englishRashi = ops.filter((o) => o.font === "rashiLatin");
    expect(hebrewRashi.length).toBeGreaterThan(0);
    expect(englishRashi.length).toBeGreaterThan(0);
    // Rashi is the smaller text; verses stay in the body fonts
    expect(hebrewRashi.every((o) => o.size < r.fontSize && o.dir === "rtl")).toBe(true);
    expect(ops.filter((o) => o.role === "body" && o.size === r.fontSize).every((o) => o.font === "hebrew" || o.font === "regular")).toBe(true);
    expect(ops.filter((o) => o.role === "heading" && o.dir === "rtl").every((o) => o.font === "title")).toBe(true);
    const names = (await Promise.all(r.plan.pages.map(async (_, i) => pageFonts(await PDFDocument.load(r.bytes), i)))).flat().join(" ");
    for (const n of [/Ezra/i, /DavidLibre-Bold/i, /DavidLibre-Regular/i, /EBGaramond-Regular/i, /EBGaramond-Bold/i, /LibreBaskerville-Regular/i]) expect(names).toMatch(n);
  });

  it("with no Rashi fonts, Rashi uses the body fonts (a family of one weight)", async () => {
    const r = await buildFilledPdf(base(rashiBlocks));
    const ops = r.plan.pages.flat();
    expect(ops.some((o) => o.font === "rashi" || o.font === "rashiLatin")).toBe(false);
    expect(ops.filter((o) => o.role === "body" && o.dir === "rtl").every((o) => o.font === "hebrew")).toBe(true);
  });

  it("a Rashi font that cannot be read is refused with the plain message", async () => {
    await expect(buildFilledPdf(base(rashiBlocks, { rashiFont: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }))).rejects.toThrow(/could not be read/);
    await expect(buildFilledPdf(base(rashiBlocks, { latinRashiFont: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }))).rejects.toThrow(/could not be read/);
  });
});
