import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { parseStudyPage, type StudySection } from "./page";
import { buildFilledPdf, type FillInput } from "./fill";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const HALF_LETTER = { width: 396, height: 612 };
const base = (sections: StudySection[], over: Partial<FillInput> = {}): FillInput => ({
  title: "Daily study",
  items: [{ title: "Rambam", sections }],
  language: "both",
  page: HALF_LETTER,
  margin: 28,
  ...over,
});
const rambam = parseStudyPage(fixture("study-rambam3.html"), "rambam3").sections;
/** The same few verses repeated, so there is enough text to need many pages. */
const long = (n: number): StudySection[] => Array.from({ length: n }, () => rambam).flat();

// Laying out and drawing many pages in two fonts takes a few seconds.
vi.setConfig({ testTimeout: 60_000 });

describe("buildFilledPdf", () => {
  it("makes pages of exactly the asked size, in a multiple of four, within the font range", async () => {
    const r = await buildFilledPdf(base(long(8)));
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPageCount()).toBe(r.pages);
    expect(r.pages % 4).toBe(0);
    for (const p of doc.getPages()) expect(p.getSize()).toEqual(HALF_LETTER);
    expect(r.fontSize).toBeGreaterThanOrEqual(10.5);
    expect(r.fontSize).toBeLessThanOrEqual(14);
  });

  it("fills the booklet: uses the fewest sheets that keep the text readable, with the last page well used", async () => {
    const r = await buildFilledPdf(base(long(8)));
    expect(r.pages).toBe(r.targetPages);
    expect(r.lastPageFill).toBeGreaterThan(0.5);
    // the same text at the smallest size needs no more pages than were chosen
    expect(r.pagesAtMinSize).toBeLessThanOrEqual(r.targetPages);
    expect(r.pagesAtMinSize).toBeGreaterThan(r.targetPages - 4);
  });

  it("makes the text bigger when there is little of it, up to a limit", async () => {
    const small = await buildFilledPdf(base(rambam.slice(0, 1)));
    const large = await buildFilledPdf(base(long(8)));
    expect(small.fontSize).toBeGreaterThan(large.fontSize);
    expect(small.fontSize).toBeLessThanOrEqual(14);
  });

  it("never draws outside the margins", async () => {
    const r = await buildFilledPdf(base(long(4)));
    for (const page of r.plan.pages) {
      for (const op of page) {
        expect(op.x).toBeGreaterThanOrEqual(28 - 0.01);
        expect(op.x + op.width).toBeLessThanOrEqual(396 - 28 + 0.01);
        expect(op.y).toBeGreaterThanOrEqual(28 - 0.01);
        expect(op.y).toBeLessThanOrEqual(612 - 28 + 0.01);
      }
    }
  });

  it("keeps the Hebrew exactly as saved, vowels and cantillation marks included", async () => {
    const chumash = parseStudyPage(fixture("study-chumash.html"), "chumash").sections;
    const r = await buildFilledPdf(base(chumash));
    const drawn = r.plan.pages.flat().map((o) => o.logical).join(" ").replace(/\s+/g, " ");
    const first = (chumash[0]?.blocks[0]?.he ?? "").replace(/\s+/g, " ");
    expect(first).toMatch(/[֑-֯]/);
    expect(drawn).toContain(first.slice(0, 60));
    expect(r.strippedMarks).toBe(false);
  });

  it("draws Hebrew in the Hebrew font and English in the English one", async () => {
    const r = await buildFilledPdf(base(rambam));
    const hebrew = r.plan.pages.flat().filter((o) => o.dir === "rtl");
    const english = r.plan.pages.flat().filter((o) => o.dir === "ltr" && o.role === "body");
    expect(hebrew.length).toBeGreaterThan(0);
    expect(hebrew.every((o) => o.font === "hebrew")).toBe(true);
    expect(english.every((o) => o.font === "regular")).toBe(true);
  });

  it("shows only the chosen language", async () => {
    const he = await buildFilledPdf(base(rambam, { language: "he" }));
    const en = await buildFilledPdf(base(rambam, { language: "en" }));
    const bodyText = (r: typeof he) => r.plan.pages.flat().filter((o) => o.role === "body").map((o) => o.logical).join(" ");
    expect(bodyText(he)).toMatch(/[א-ת]/);
    expect(bodyText(he)).not.toMatch(/[A-Za-z]{4}/);
    expect(bodyText(en)).toMatch(/following rules apply/);
    expect(bodyText(en)).not.toMatch(/[א-ת]/);
  });

  it("puts the credit line at the end when given one", async () => {
    const credit = "Text courtesy of Chabad.org. Thank you.";
    const r = await buildFilledPdf(base(rambam, { credit }));
    const last = r.plan.pages.flat().at(-1);
    expect(last?.logical).toContain("Thank you");
  });

  it("copes with no text at all", async () => {
    const r = await buildFilledPdf(base([]));
    expect(r.pages).toBe(4);
  });
});
