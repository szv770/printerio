import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { hasType3Fonts } from "./type3-fonts";

async function plain() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText("hello", { font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc;
}

describe("hasType3Fonts", () => {
  it("is false for an ordinary standard-font PDF", async () => {
    expect(hasType3Fonts(await plain())).toBe(false);
  });

  it("is true when a Type 3 font with glyph procedures is present", async () => {
    const doc = await plain();
    const font = doc.context.obj({ Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1, 1], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: {}, Encoding: {}, FirstChar: 0, LastChar: 0, Widths: [0] });
    doc.context.register(font);
    expect(hasType3Fonts(doc)).toBe(true);
    // survives a save and reload, as in the real pipeline
    const again = await PDFDocument.load(await doc.save());
    expect(hasType3Fonts(again)).toBe(true);
  });

  it("ignores a Subtype /Type3 dictionary that is not a font program (no CharProcs)", async () => {
    const doc = await plain();
    doc.context.register(doc.context.obj({ Subtype: "Type3" }));
    expect(hasType3Fonts(doc)).toBe(false);
    expect(PDFDict && PDFName).toBeTruthy();
  });
});
