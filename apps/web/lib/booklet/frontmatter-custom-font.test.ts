import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("server-only", () => ({}));
import { PDFDocument } from "pdf-lib";
import { pageFonts } from "@/test/hebrew-fixtures";
import { assembleBooklet, BuilderError } from "./assemble";
import { addFrontMatter, drawBackPageText, frontMatterPageCount, type FrontMatterInput } from "./frontmatter";
import { EZRA_SIL_REGULAR_BASE64 } from "./fonts/ezra-sil-regular";

// Ezra SIL stands in for an uploaded font; the built-in Hebrew and Latin font is David Libre.
const EZRA = new Uint8Array(Buffer.from(EZRA_SIL_REGULAR_BASE64, "base64"));
// Fonts are only written into the document when it is saved, so read them back from a saved copy.
const saved = async (doc: PDFDocument) => PDFDocument.load(await doc.save());
const names = (doc: PDFDocument, page: number) => pageFonts(doc, page).join(" ");
const SIZE = { width: 396, height: 612 };
const manyEntries = Array.from({ length: 40 }, (_, i) => ({ title: `שיחה ${i + 1} - ליקוטי שיחות חלק ה על פרשת וירא`, startPage: i + 5 }));
const front = (over: Partial<FrontMatterInput> = {}): FrontMatterInput => ({
  title: "ליקוטי שיחות",
  description: "מבחר שיחות לשבת",
  direction: "rtl",
  entries: manyEntries,
  credits: ["באדיבות חב\"ד"],
  cover: true,
  contents: true,
  size: SIZE,
  ...over,
});

describe("front matter with an uploaded Hebrew font", () => {
  it("draws Hebrew cover and contents in that font, and keeps David Libre when none is given", async () => {
    const draft = await PDFDocument.create();
    const added = await addFrontMatter(draft, front({ hebrewFont: EZRA }));
    const withFont = await saved(draft);
    expect(added).toBeGreaterThan(2);
    for (let i = 0; i < added; i++) expect(names(withFont, i), `page ${i}`).toMatch(/Ezra/i);
    // page numbers are digits and stay in David Libre
    expect(names(withFont, 1)).toMatch(/DavidLibre/i);

    const plainDraft = await PDFDocument.create();
    await addFrontMatter(plainDraft, front());
    const without = await saved(plainDraft);
    for (let i = 0; i < without.getPageCount(); i++) expect(names(without, i)).not.toMatch(/Ezra/i);
  });

  it("does not use the Hebrew font for English-only text", async () => {
    const draft = await PDFDocument.create();
    await addFrontMatter(draft, front({ title: "Likkutei Sichos", description: "Selected talks", direction: "ltr", entries: [{ title: "Vayera", startPage: 3 }], credits: [], hebrewFont: EZRA }));
    const doc = await saved(draft);
    for (let i = 0; i < doc.getPageCount(); i++) expect(names(doc, i)).not.toMatch(/Ezra/i);
  });

  it("counts the same pages whether measured or drawn", async () => {
    for (const hebrewFont of [undefined, EZRA]) {
      const input = front(hebrewFont ? { hebrewFont } : {});
      const counted = await frontMatterPageCount(input);
      const doc = await PDFDocument.create();
      const added = await addFrontMatter(doc, input);
      expect(added).toBe(counted);
      expect(doc.getPageCount()).toBe(counted);
      expect(counted).toBeGreaterThan(2);
    }
  });

  it("draws the back page text in that font", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([SIZE.width, SIZE.height]);
    await drawBackPageText(doc, { credits: ["באדיבות חב\"ד"], sponsorLine: "לעילוי נשמת", direction: "rtl", size: SIZE, hebrewFont: EZRA });
    expect(names(await saved(doc), 0)).toMatch(/Ezra/i);
  });

  it("is used by the booklet builder, and an unreadable font is a plain refusal", async () => {
    const source = await PDFDocument.create();
    source.addPage([396, 612]);
    const bytes = await source.save();
    const base = { title: "ליקוטי שיחות", description: "", direction: "rtl" as const, cover: true, contents: true, sponsorLine: "לעילוי נשמת", sources: [{ title: "שיחה א", bytes, credit: "באדיבות חב\"ד" }] };
    const r = await assembleBooklet({ ...base, hebrewFont: EZRA });
    const doc = await PDFDocument.load(r.bytes);
    expect(r.backPage).toBe(true);
    for (const i of [0, 1, doc.getPageCount() - 1]) expect(names(doc, i), `page ${i}`).toMatch(/Ezra/i);
    const plain = await assembleBooklet(base);
    expect(plain.pageCount).toBe(r.pageCount);
    expect(plain.entries).toEqual(r.entries);

    await expect(assembleBooklet({ ...base, hebrewFont: new Uint8Array([1, 2, 3, 4]) })).rejects.toThrow(BuilderError);
    await expect(assembleBooklet({ ...base, hebrewFont: new Uint8Array([1, 2, 3, 4]) })).rejects.toThrow(/That font could not be read/);
  });
});
