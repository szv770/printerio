import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { preparePdf, type PreparePdfInput, type PrepareLogger } from "./prepare";
import { readStamp } from "./test-support/read-stamp";
import { makeHebrewPdf, nonAscii, pageTexts } from "./test-support/hebrew-fixtures";

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 72, y: 700 });
  return doc.save();
}

function logger(): PrepareLogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() };
}

async function input(over: Partial<PreparePdfInput> & { pages?: number } = {}): Promise<PreparePdfInput> {
  const { pages, ...rest } = over;
  return {
    originalBytes: await pdf(pages ?? 5),
    maxUploadBytes: 50 * 1024 * 1024,
    colorMode: "bw",
    heldReason: null,
    pageRangeText: null,
    booklet: false,
    bookletOptions: { paperSize: "letter", bindingSide: "left", fit: "fill", sheet: "letter" },
    confirmBookletPadding: false,
    stamp: null,
    allowType3Fonts: false,
    logContext: { organizationId: "org1", printerProfileId: "prof1" },
    logger: logger(),
    ...rest,
  };
}
const pageCount = async (bytes: Uint8Array | null) => (await PDFDocument.load(bytes!)).getPageCount();

describe("preparePdf (the PDF half of a print job, no database)", () => {
  it("a plain clean PDF: counts the pages and needs no derived file (the stored original prints as it is)", async () => {
    const r = await preparePdf(await input());
    expect(r).toMatchObject({ ok: true, held: false, heldReason: null, derivedBytes: null, sourcePages: 5, effectivePageCount: 5, blankPagesAdded: 0, pageRangeText: null, pictureCopy: false });
    if (r.ok) expect(r.fileSizeBytes).toBeGreaterThan(100);
  });

  it("something that is not a PDF is refused with a plain reason", async () => {
    const r = await preparePdf(await input({ originalBytes: new TextEncoder().encode("hello, I am not a pdf") }));
    expect(r).toMatchObject({ ok: false, kind: "error", code: "bad_pdf" });
  });

  it("a page range pulls those pages into a derived file and counts only them", async () => {
    const r = await preparePdf(await input({ pageRangeText: "2-3" }));
    expect(r).toMatchObject({ ok: true, sourcePages: 2, effectivePageCount: 2, pageRangeText: "2-3" });
    if (r.ok) expect(await pageCount(r.derivedBytes)).toBe(2);
  });

  it("a range that does not fit is an inline error on the page-range field", async () => {
    const r = await preparePdf(await input({ pageRangeText: "9" }));
    expect(r).toMatchObject({ ok: false, kind: "error", code: "invalid_page_range" });
    if (!r.ok && r.kind === "error") expect(r.fieldErrors?.pageRange).toBe(r.error);
  });

  it("a forced hold (the print dialog) never fails on a bad range: the job is held with both reasons and the range is dropped", async () => {
    const r = await preparePdf(await input({ pageRangeText: "9", heldReason: "Not supported here.", forcedHeldReason: "Not supported here." }));
    expect(r).toMatchObject({ ok: true, held: true, pageRangeText: null, sourcePages: 5 });
    if (r.ok) expect(r.heldReason).toContain("Not supported here.");
  });

  it("a booklet that needs blank pages asks first; once confirmed it is imposed and says how many blanks were added", async () => {
    const ask = await preparePdf(await input({ booklet: true, pages: 5 }));
    expect(ask).toMatchObject({ ok: false, kind: "needs_booklet_confirm", needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } });

    const done = await preparePdf(await input({ booklet: true, pages: 5, confirmBookletPadding: true }));
    expect(done).toMatchObject({ ok: true, held: false, effectivePageCount: 8, blankPagesAdded: 3 });
    if (done.ok) expect(await pageCount(done.derivedBytes)).toBe(4); // 8 pages -> 4 landscape sheet sides
  });

  it("a held job builds no derived file and no imposition, only an estimate (a held booklet still counts its padded pages)", async () => {
    const r = await preparePdf(await input({ booklet: true, pages: 5, heldReason: "Choose a binding side." }));
    expect(r).toMatchObject({ ok: true, held: true, heldReason: "Choose a binding side.", derivedBytes: null, effectivePageCount: 8, blankPagesAdded: 0 });
  });
});

describe("preparePdf: the user code stamp", () => {
  it("a stamp plan is put on page 1 of the final file", async () => {
    const r = await preparePdf(await input({ stamp: { text: "SV42 2026-11-19", strength: "medium" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(readStamp(await PDFDocument.load(r.derivedBytes!), 0)?.text).toBe("SV42 2026-11-19");
  });

  it("the stamp is built lazily: NOT at all for a held job (building it can write to the database)", async () => {
    const build = vi.fn(async () => ({ text: "X", strength: "light" as const }));
    await preparePdf(await input({ heldReason: "held", stamp: build }));
    expect(build).not.toHaveBeenCalled();
  });

  it("the stamp is built exactly once for a normal job, and that is what gets stamped", async () => {
    const build = vi.fn(async () => ({ text: "RCI", strength: "light" as const }));
    const r = await preparePdf(await input({ stamp: build }));
    expect(build).toHaveBeenCalledTimes(1);
    if (r.ok) expect(readStamp(await PDFDocument.load(r.derivedBytes!), 0)?.text).toBe("RCI");
  });

  it("if the stamp cannot be built the job still goes through unstamped (losing a print is worse than losing a label), and it is logged", async () => {
    const log = logger();
    const r = await preparePdf(await input({ logger: log, stamp: async () => { throw new Error("could not save the code"); } }));
    expect(r).toMatchObject({ ok: true, held: false, derivedBytes: null });
    expect(log.error).toHaveBeenCalledWith("user code stamp failed; printing without it", expect.objectContaining({ organizationId: "org1", error: "could not save the code" }));
  });

  it("a stamp plan of null (no code available) just skips the stamp", async () => {
    const r = await preparePdf(await input({ stamp: async () => null }));
    expect(r).toMatchObject({ ok: true, derivedBytes: null });
  });
});

describe("preparePdf page layout (n-up / step and repeat)", () => {
  const frozen = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  };

  it("5 pages 4-up: 2 physical pages are counted, 5 source pages stay 5, and a derived file is made", async () => {
    const r = await preparePdf(await input({ layout: { kind: "nup", cols: 2, rows: 2 } }));
    expect(r).toMatchObject({ ok: true, held: false, sourcePages: 5, effectivePageCount: 2, blankPagesAdded: 0 });
    if (r.ok) expect(await pageCount(r.derivedBytes)).toBe(2);
  });

  it("the layout runs after the page range: pages 2-4 of 5, 2-up = 2 sides", async () => {
    const r = await preparePdf(await input({ pageRangeText: "2-4", layout: { kind: "nup", cols: 2, rows: 1 } }));
    expect(r).toMatchObject({ ok: true, sourcePages: 3, effectivePageCount: 2 });
  });

  it("repeat one chosen page: one side; a page that is not in the range result is an inline error", async () => {
    const r = await preparePdf(await input({ layout: { kind: "repeat", cols: 4, rows: 3, pages: 5, marks: true } }));
    expect(r).toMatchObject({ ok: true, sourcePages: 5, effectivePageCount: 1 });
    const bad = await preparePdf(await input({ layout: { kind: "repeat", cols: 2, rows: 2, pages: 7 } }));
    expect(bad).toMatchObject({ ok: false, kind: "error" });
  });

  it("a held job prints nothing but still gets the right page count", async () => {
    const r = await preparePdf(await input({ heldReason: "needs approval", layout: { kind: "nup", cols: 3, rows: 3 } }));
    expect(r).toMatchObject({ ok: true, held: true, derivedBytes: null, effectivePageCount: 1, sourcePages: 5 });
  });

  it("layout together with a booklet is refused with a plain message", async () => {
    const r = await preparePdf(await input({ booklet: true, layout: { kind: "nup", cols: 2, rows: 1 } }));
    expect(r).toMatchObject({ ok: false, kind: "error" });
    if (!r.ok && r.kind === "error") expect(r.error).toMatch(/can't be combined/);
  });

  it("a nonsense layout is refused before any PDF work", async () => {
    const r = await preparePdf(await input({ layout: { kind: "nup", cols: 0, rows: 2 } }));
    expect(r).toMatchObject({ ok: false, kind: "error" });
  });

  it("without a layout the result is byte-for-byte what it was (plain, range and booklet)", async () => {
    frozen();
    try {
      for (const over of [{}, { pageRangeText: "2-3" }, { booklet: true, confirmBookletPadding: true }] as const) {
        const base = await input({ ...over });
        const a = await preparePdf(base);
        const b = await preparePdf({ ...base, layout: undefined });
        expect(b).toEqual(a);
      }
      const booklet = await preparePdf(await input({ booklet: true, confirmBookletPadding: true }));
      expect(booklet).toMatchObject({ ok: true, effectivePageCount: 8, blankPagesAdded: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Hebrew text survives n-up and repeat: the text check passes and every sheet carries its pages' letters", async () => {
    const original = await makeHebrewPdf({ pages: [["שלום עולם"], ["ברוכים הבאים"], ["תניא - ליקוטי אמרים"]] });
    const src = (await pageTexts(original)).map(nonAscii);
    const nup = await preparePdf(await input({ originalBytes: original, layout: { kind: "nup", cols: 2, rows: 1 } }));
    expect(nup).toMatchObject({ ok: true, held: false, effectivePageCount: 2 });
    if (!nup.ok) return;
    const out = (await pageTexts(nup.derivedBytes!)).map(nonAscii);
    expect(out.map((t) => [...t].sort().join(""))).toEqual([[...(src[0]! + src[1]!)].sort().join(""), [...src[2]!].sort().join("")]);
    const rep = await preparePdf(await input({ originalBytes: original, layout: { kind: "repeat", cols: 2, rows: 2, pages: 2 } }));
    expect(rep).toMatchObject({ ok: true, held: false, effectivePageCount: 1 });
  });

  it("the text check is still live for layouts: a derived file with the wrong letters would hold the job", async () => {
    const { checkTextFidelity } = await import("./text-fidelity");
    const original = await makeHebrewPdf({ pages: [["שלום עולם"], ["ברוכים הבאים"]] });
    const other = await makeHebrewPdf({ pages: [["ברוכים הבאים"], ["שלום עולם"]] });
    const nup = await preparePdf(await input({ originalBytes: original, layout: { kind: "nup", cols: 1, rows: 1 } }));
    if (!nup.ok) throw new Error("layout failed");
    const same = await checkTextFidelity({ original, derived: nup.derivedBytes!, sourcePages: null, booklet: false, groups: [[1], [2]] });
    expect(same.status).toBe("ok");
    const wrong = await checkTextFidelity({ original, derived: other, sourcePages: null, booklet: false, groups: [[1], [2]] });
    expect(wrong.status).toBe("changed");
  });
});

describe("preparePdf with a picture upload", () => {
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 0, 1, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

  it("a JPEG is converted to a one-page PDF first and always prints from that derived file", async () => {
    const r = await preparePdf(await input({ originalBytes: jpegBytes }));
    expect(r).toMatchObject({ ok: true, sourcePages: 1, effectivePageCount: 1, pictureCopy: false, fileSizeBytes: jpegBytes.byteLength });
    if (r.ok) expect(await pageCount(r.derivedBytes)).toBe(1);
  });

  it("the page range then applies to the single page, and a picture can be laid out", async () => {
    const bad = await preparePdf(await input({ originalBytes: jpegBytes, pageRangeText: "2" }));
    expect(bad).toMatchObject({ ok: false, code: "invalid_page_range" });
    const rep = await preparePdf(await input({ originalBytes: jpegBytes, layout: { kind: "repeat", cols: 2, rows: 3, pages: "first" } }));
    expect(rep).toMatchObject({ ok: true, effectivePageCount: 1 });
  });

  it("a picture over the upload limit keeps the website's limit wording; a bomb-sized one is refused plainly; other files keep the PDF message", async () => {
    const big = await preparePdf(await input({ originalBytes: jpegBytes, maxUploadBytes: 10 }));
    expect(big).toMatchObject({ ok: false, code: "bad_pdf" });
    if (!big.ok && big.kind === "error") expect(big.error).toMatch(/upload limit/);
    const huge = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xff, 0xff, 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    const r = await preparePdf(await input({ originalBytes: huge }));
    expect(r).toMatchObject({ ok: false, code: "bad_pdf" });
    if (!r.ok && r.kind === "error") expect(r.error).toMatch(/too large to print/);
    const txt = await preparePdf(await input({ originalBytes: new TextEncoder().encode("plain text") }));
    if (!txt.ok && txt.kind === "error") expect(txt.error).toBe("This file doesn't look like a PDF. Choose a PDF file.");
  });
});
