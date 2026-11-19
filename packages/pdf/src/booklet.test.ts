import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createBookletPaddedPdf } from "./booklet";

async function makeValidPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  return doc.save();
}

describe("createBookletPaddedPdf", () => {
  it("pads a 6-page document to 8 pages, matching the spec's example", async () => {
    const bytes = await makeValidPdf(6);
    const derived = await createBookletPaddedPdf(bytes);
    expect(derived.paddedPages).toBe(8);
    expect(derived.blankPagesAdded).toBe(2);

    const derivedDoc = await PDFDocument.load(derived.bytes);
    expect(derivedDoc.getPageCount()).toBe(8);
  });

  it("does not modify a document already a multiple of 4", async () => {
    const bytes = await makeValidPdf(12);
    const derived = await createBookletPaddedPdf(bytes);
    expect(derived.paddedPages).toBe(12);
    expect(derived.blankPagesAdded).toBe(0);
  });

  it("never mutates the original bytes passed in", async () => {
    const bytes = await makeValidPdf(6);
    const copy = bytes.slice();
    await createBookletPaddedPdf(bytes);
    expect(bytes).toEqual(copy);
  });
});
