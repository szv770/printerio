import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { pageContent, readStamp } from "@/test/read-stamp";
import { stampFirstPage, STAMP_FONT_SIZE_PT, STAMP_INSET_PT, STAMP_GREY } from "./stamp";
import { imposeBookletPdf, resolvePaperSizePoints } from "./imposition";
import { createBookletPaddedPdf } from "./booklet";

// pdf-lib boxes are [x, y, width, height]
type Box = [number, number, number, number];
async function makePdf(pages: Array<{ size: [number, number]; rotate?: number; crop?: Box; media?: Box }>) {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage(p.size);
    if (p.media) page.setMediaBox(...p.media);
    if (p.crop) page.setCropBox(...p.crop);
    if (p.rotate) page.setRotation(degrees(p.rotate));
    page.drawText("body", { x: 72, y: p.size[1] - 72, size: 12 });
  }
  return doc.save();
}

const load = (b: Uint8Array) => PDFDocument.load(b);

describe("stampFirstPage", () => {
  it("stamps page 1 only", async () => {
    const out = await load(await stampFirstPage(await makePdf([{ size: [612, 792] }, { size: [612, 792] }, { size: [612, 792] }]), { text: "SV42" }));
    expect(readStamp(out, 0)?.text).toBe("SV42");
    expect(readStamp(out, 1)).toBeNull();
    expect(readStamp(out, 2)).toBeNull();
  });

  it("does not change page count, page sizes or rotation", async () => {
    const src = await makePdf([{ size: [612, 792] }, { size: [842, 595] }, { size: [300, 400], rotate: 90 }]);
    const out = await load(await stampFirstPage(src, { text: "SV42" }));
    const before = await load(src);
    expect(out.getPageCount()).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(out.getPage(i).getSize()).toEqual(before.getPage(i).getSize());
      expect(out.getPage(i).getRotation().angle).toBe(before.getPage(i).getRotation().angle);
    }
  });

  it("puts the stamp in the bottom-right corner (clear of top staples), about 9 pt, light grey, outside typical margins (portrait)", async () => {
    const s = readStamp(await load(await stampFirstPage(await makePdf([{ size: [612, 792] }]), { text: "SV42" })), 0)!;
    expect(s.angle).toBe(0);
    expect(s.y).toBeLessThan(36); // inside the bottom 0.5in band: below any normal margin
    expect(s.y).toBeGreaterThan(STAMP_INSET_PT - 1);
    expect(s.x).toBeGreaterThan(612 - 36 - 30);
    expect(s.x).toBeLessThan(612 - STAMP_INSET_PT); // text starts left of the inset line, so it ends on it
    expect(STAMP_FONT_SIZE_PT).toBe(9);
    expect(STAMP_GREY.light).toBeGreaterThan(0.5);
    expect(s.content).toContain(`${STAMP_GREY.light} g`); // grey fill, not black
  });

  it("is upright in the visible orientation for every /Rotate value", async () => {
    for (const rotate of [0, 90, 180, 270] as const) {
      const doc = await load(await stampFirstPage(await makePdf([{ size: [600, 800], rotate }]), { text: "SV42" }));
      const s = readStamp(doc, 0)!;
      expect(s.angle).toBe(rotate);
      // The text start must sit near the corner that is visually bottom-right for that rotation.
      const corner = { 0: [600, 0], 90: [600, 800], 180: [0, 800], 270: [0, 0] }[rotate];
      expect(Math.abs(s.x - corner[0]!)).toBeLessThan(60);
      expect(Math.abs(s.y - corner[1]!)).toBeLessThan(60);
    }
  });

  it("the text's right edge sits exactly on the right inset and its baseline on the bottom inset, for every /Rotate, CropBox and MediaBox offset", async () => {
    const font = await (async () => {
      const d = await PDFDocument.create();
      return d.embedFont(StandardFonts.Helvetica);
    })();
    const text = "SV42 2026-10-22";
    const w = font.widthOfTextAtSize(text, STAMP_FONT_SIZE_PT);
    // visible box in user space [left, bottom, right, top]
    const boxes: Array<{ media: [number, number, number, number]; crop?: [number, number, number, number] }> = [
      { media: [0, 0, 600, 800] },
      { media: [-100, -200, 500, 600] },
      { media: [0, 0, 700, 900], crop: [50, 60, 650, 860] },
    ];
    for (const b of boxes) {
      const vis = b.crop ?? b.media;
      const [l, bo, r, t] = vis;
      for (const rotate of [0, 90, 180, 270] as const) {
        const xywh = (v: [number, number, number, number]): Box => [v[0], v[1], v[2] - v[0], v[3] - v[1]];
        const src = await makePdf([{ size: [600, 800], rotate, media: xywh(b.media), crop: b.crop ? xywh(b.crop) : undefined }]);
        const s = readStamp(await load(await stampFirstPage(src, { text: text })), 0)!;
        // Baseline-left and the text direction in user space; the right end is x + w*(cos, sin).
        const rad = (s.angle * Math.PI) / 180;
        const ex = s.x + w * Math.cos(rad);
        const ey = s.y + w * Math.sin(rad);
        const I = STAMP_INSET_PT;
        const expected = {
          0: { ex: r - I, ey: bo + I },
          90: { ex: r - I, ey: t - I },
          180: { ex: l + I, ey: t - I },
          270: { ex: l + I, ey: bo + I },
        }[rotate];
        expect(ex).toBeCloseTo(expected.ex, 1);
        expect(ey).toBeCloseTo(expected.ey, 1);
      }
    }
  });

  it("handles landscape pages", async () => {
    const s = readStamp(await load(await stampFirstPage(await makePdf([{ size: [792, 612] }]), { text: "SV42" })), 0)!;
    expect(s.y).toBeLessThan(36);
    expect(s.x).toBeGreaterThan(792 - 100);
  });

  it("uses the CropBox (the visible region) when it differs from the MediaBox", async () => {
    const src = await makePdf([{ size: [612, 792], media: [0, 0, 700, 900], crop: [50, 60, 600, 800] }]);
    const s = readStamp(await load(await stampFirstPage(src, { text: "SV42" })), 0)!;
    expect(s.y).toBeGreaterThan(60);
    expect(s.y).toBeLessThan(60 + 36);
    expect(s.x).toBeLessThan(650 - STAMP_INSET_PT);
    expect(s.x).toBeGreaterThan(650 - 100);
  });

  it("handles a MediaBox whose origin is not 0,0", async () => {
    const src = await makePdf([{ size: [612, 792], media: [-100, -200, 612, 792] }]);
    const s = readStamp(await load(await stampFirstPage(src, { text: "SV42" })), 0)!;
    expect(s.y).toBeGreaterThan(-200);
    expect(s.y).toBeLessThan(-200 + 36);
    expect(s.x).toBeGreaterThan(512 - 100);
    expect(s.x).toBeLessThan(512);
  });

  it("stronger settings use a darker grey", async () => {
    const light = readStamp(await load(await stampFirstPage(await makePdf([{ size: [612, 792] }]), { text: "A1", strength: "light" })), 0)!;
    const strong = readStamp(await load(await stampFirstPage(await makePdf([{ size: [612, 792] }]), { text: "A1", strength: "strong" })), 0)!;
    expect(light.content).toContain(`${STAMP_GREY.light} g`);
    expect(strong.content).toContain(`${STAMP_GREY.strong} g`);
    expect(STAMP_GREY.strong).toBeLessThan(STAMP_GREY.light);
  });

  it("keeps the original page content and only adds to it", async () => {
    const src = await makePdf([{ size: [612, 792] }]);
    const before = pageContent(await load(src), 0);
    const after = pageContent(await load(await stampFirstPage(src, { text: "SV42" })), 0);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain("Tj");
    expect(before.match(/Tj/g)?.length).toBe(1);
    expect(after.match(/Tj/g)?.length).toBe(2);
  });

  it("survives booklet imposition when stamped after it (cover sheet = page 1 of the final layout)", async () => {
    const src = await makePdf([{ size: [612, 792] }, { size: [612, 792] }, { size: [612, 792] }, { size: [612, 792] }]);
    const padded = await createBookletPaddedPdf(src);
    const imposed = await imposeBookletPdf(padded.bytes, resolvePaperSizePoints("letter"), "left");
    const stamped = await load(await stampFirstPage(imposed, { text: "SV42" }));
    const plain = await load(imposed);
    expect(stamped.getPageCount()).toBe(plain.getPageCount());
    expect(stamped.getPage(0).getSize()).toEqual(plain.getPage(0).getSize());
    const s = readStamp(stamped, 0)!;
    const { width, height } = stamped.getPage(0).getSize();
    expect(s.text).toBe("SV42");
    expect(s.x).toBeGreaterThan(width - 100);
    expect(s.y).toBeLessThan(36); // bottom-right, clear of top staples
    expect(height).toBeGreaterThan(36);
    expect(readStamp(stamped, 1)).toBeNull();
  });

  it("drops characters a standard font cannot draw instead of throwing", async () => {
    const out = await load(await stampFirstPage(await makePdf([{ size: [612, 792] }]), { text: "Ünï-42☃" }));
    expect(readStamp(out, 0)?.text).toMatch(/^[\x20-\x7e]+$/);
  });

  it("returns the input unchanged for empty text", async () => {
    const src = await makePdf([{ size: [612, 792] }]);
    expect(await stampFirstPage(src, { text: "   " })).toBe(src);
  });
});
