import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createPageSubsetPdf } from "./page-subset";

/** Page i (1-based) gets width 100 + i so each page can be identified after copying. */
async function makeNumberedPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pageCount; i++) doc.addPage([100 + i, 200]);
  return doc.save();
}

async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getWidth());
}

describe("createPageSubsetPdf", () => {
  it("keeps only the selected pages, in the given order", async () => {
    const out = await createPageSubsetPdf(await makeNumberedPdf(10), [1, 2, 3, 8]);
    expect(await widths(out)).toEqual([101, 102, 103, 108]);
  });

  it("keeps the order it is given (not sorted)", async () => {
    const out = await createPageSubsetPdf(await makeNumberedPdf(5), [4, 2]);
    expect(await widths(out)).toEqual([104, 102]);
  });

  it("works for a single page", async () => {
    const out = await createPageSubsetPdf(await makeNumberedPdf(3), [3]);
    expect(await widths(out)).toEqual([103]);
  });

  it("never mutates the original bytes", async () => {
    const bytes = await makeNumberedPdf(6);
    const copy = bytes.slice();
    await createPageSubsetPdf(bytes, [2, 3]);
    expect(bytes).toEqual(copy);
  });

  it("rejects an empty selection and out-of-range pages instead of producing a wrong document", async () => {
    const bytes = await makeNumberedPdf(3);
    await expect(createPageSubsetPdf(bytes, [])).rejects.toThrow();
    await expect(createPageSubsetPdf(bytes, [4])).rejects.toThrow();
    await expect(createPageSubsetPdf(bytes, [0])).rejects.toThrow();
  });
});
