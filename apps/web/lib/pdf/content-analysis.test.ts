import { describe, expect, it, vi } from "vitest";

// The first call loads pdfjs (a large module); allow for a cold start.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { analyzePdfContent, MAX_ANALYSIS_BYTES, TIME_BUDGET_MS, RASTER_BUDGET_MS } from "./content-analysis";

// A 2x2 red PNG, drawn at a known position and size.
const PNG_2X2 = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYEJRDAAAB4AAgPj6GvPAAAAAElFTkSuQmCC", "base64"),
);

async function build(fn: (doc: PDFDocument) => Promise<void> | void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await fn(doc);
  return doc.save();
}

describe("analyzePdfContent", () => {
  it("finds the ink box of a text-only page, ignoring the blank margins", async () => {
    const bytes = await build(async (doc) => {
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("Hello there, this is body text", { x: 72, y: 700, size: 12, font });
      page.drawText("Last line", { x: 72, y: 90, size: 12, font });
    });
    const res = await analyzePdfContent(bytes);
    expect(res).not.toBeNull();
    const c = res![0]!;
    expect(c.kind).toBe("content");
    if (c.kind !== "content") return;
    expect(c.box.x0).toBeGreaterThanOrEqual(70);
    expect(c.box.x0).toBeLessThanOrEqual(73);
    expect(c.box.x1).toBeGreaterThan(150);
    expect(c.box.x1).toBeLessThan(300);
    expect(c.box.y0).toBeGreaterThan(84);
    expect(c.box.y0).toBeLessThanOrEqual(90);
    expect(c.box.y1).toBeGreaterThanOrEqual(708);
    expect(c.box.y1).toBeLessThan(716);
  });

  it("counts an image over its placed box", async () => {
    const bytes = await build(async (doc) => {
      const page = doc.addPage([612, 792]);
      const img = await doc.embedPng(PNG_2X2);
      page.drawImage(img, { x: 100, y: 200, width: 300, height: 150 });
    });
    const c = (await analyzePdfContent(bytes))![0]!;
    expect(c.kind).toBe("content");
    if (c.kind !== "content") return;
    expect(c.box.x0).toBeCloseTo(100, 0);
    expect(c.box.y0).toBeCloseTo(200, 0);
    expect(c.box.x1).toBeCloseTo(400, 0);
    expect(c.box.y1).toBeCloseTo(350, 0);
  });

  it("counts vector graphics, but not a white page-sized background rectangle", async () => {
    const bytes = await build((doc) => {
      const page = doc.addPage([612, 792]);
      page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
      page.drawRectangle({ x: 120, y: 300, width: 200, height: 40, color: rgb(1, 0, 0) });
    });
    const c = (await analyzePdfContent(bytes))![0]!;
    expect(c.kind).toBe("content");
    if (c.kind !== "content") return;
    expect(c.box.x0).toBeCloseTo(120, 0);
    expect(c.box.x1).toBeCloseTo(320, 0);
    expect(c.box.y0).toBeCloseTo(300, 0);
    expect(c.box.y1).toBeCloseTo(340, 0);
  });

  it("reports a blank page as blank", async () => {
    const bytes = await build((doc) => {
      doc.addPage([612, 792]);
    });
    expect((await analyzePdfContent(bytes))![0]).toEqual({ kind: "blank" });
  });

  it("reports a rotated page as unknown (never guesses)", async () => {
    const bytes = await build(async (doc) => {
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("rotated", { x: 72, y: 700, size: 12, font });
      page.setRotation(degrees(90));
    });
    expect((await analyzePdfContent(bytes))![0]).toEqual({ kind: "unknown" });
  });

  it("returns null for bytes that are not a PDF", async () => {
    expect(await analyzePdfContent(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("analysis cost limits", () => {
  it("skips (returns null, so the booklet stays whole) a document above the size threshold without parsing it", async () => {
    const big = new Uint8Array(MAX_ANALYSIS_BYTES + 1);
    expect(await analyzePdfContent(big)).toBeNull();
  });
  it("uses short time budgets", () => {
    expect(TIME_BUDGET_MS).toBeLessThanOrEqual(4_000);
    expect(RASTER_BUDGET_MS).toBeLessThanOrEqual(2_000);
  });
});
