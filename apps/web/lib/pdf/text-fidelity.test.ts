import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeHebrewPdf, HEBREW_LINES, MIXED_LINES } from "@/test/hebrew-fixtures";
import { padAndImposeBooklet } from "./booklet-build";
import { createPageSubsetPdf } from "./page-subset";
import { checkTextFidelity } from "./text-fidelity";

const asciiPdf = async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Hello world 123", { x: 50, y: 700, font });
  return doc.save();
};

describe("checkTextFidelity", () => {
  it("is ok when the derived file has the same Hebrew text", async () => {
    const original = await makeHebrewPdf({ pages: [HEBREW_LINES, MIXED_LINES] });
    expect((await checkTextFidelity({ original, derived: original.slice(), sourcePages: null, booklet: false })).status).toBe("ok");
  });

  it("does not even look at the derived file when the original has no non-Latin text (cheap path)", async () => {
    const original = await asciiPdf();
    const res = await checkTextFidelity({ original, derived: new Uint8Array([1, 2, 3]), sourcePages: null, booklet: false });
    expect(res.status).toBe("skipped");
  });

  it("reports a change when a Hebrew letter differs on a page", async () => {
    const original = await makeHebrewPdf({ pages: [["שלום עולם"]] });
    const derived = await makeHebrewPdf({ pages: [["שלום עולן"]] });
    const res = await checkTextFidelity({ original, derived, sourcePages: null, booklet: false });
    expect(res).toMatchObject({ status: "changed", page: 1 });
  });

  it("reports a change when Hebrew text is missing from the derived page", async () => {
    const original = await makeHebrewPdf({ pages: [HEBREW_LINES] });
    const derived = await asciiPdf();
    expect((await checkTextFidelity({ original, derived, sourcePages: null, booklet: false })).status).toBe("changed");
  });

  it("maps a page subset back to the original's pages", async () => {
    const original = await makeHebrewPdf({ pages: [["אאא"], ["בבב"], ["גגג"]] });
    const derived = await createPageSubsetPdf(original, [3, 1]);
    expect((await checkTextFidelity({ original, derived, sourcePages: [3, 1], booklet: false })).status).toBe("ok");
    // the wrong mapping is a change
    expect((await checkTextFidelity({ original, derived, sourcePages: [2, 1], booklet: false })).status).toBe("changed");
  });

  it("maps booklet sheet sides back to their two source pages (padding included)", async () => {
    const original = await makeHebrewPdf({ pages: [["אאא"], ["בבב"], ["גגג"], ["דדד"], ["ההה"]] });
    const built = await padAndImposeBooklet(original, { paperSize: "letter", bindingSide: "right", fit: "keep" });
    expect((await checkTextFidelity({ original, derived: built.bytes, sourcePages: null, booklet: true })).status).toBe("ok");
    const other = await makeHebrewPdf({ pages: [["אאא"], ["בבב"], ["גגג"], ["דדד"], ["הוה"]] });
    const bad = await padAndImposeBooklet(other, { paperSize: "letter", bindingSide: "right", fit: "keep" });
    expect((await checkTextFidelity({ original, derived: bad.bytes, sourcePages: null, booklet: true })).status).toBe("changed");
  });

  it("fails open: an unreadable derived file is 'skipped', never 'changed'", async () => {
    const original = await makeHebrewPdf();
    const res = await checkTextFidelity({ original, derived: new Uint8Array([1, 2, 3, 4]), sourcePages: null, booklet: false });
    expect(res.status).toBe("skipped");
  });

  it("fails open: when the time budget is spent it is 'skipped'", async () => {
    const original = await makeHebrewPdf({ pages: [HEBREW_LINES, HEBREW_LINES] });
    const res = await checkTextFidelity({ original, derived: original.slice(), sourcePages: null, booklet: false, budgetMs: -1 });
    expect(res.status).toBe("skipped");
  });
});
