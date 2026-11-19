import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { preparePdf, type PreparePdfInput, type PrepareLogger } from "./prepare";
import { readStamp } from "./test-support/read-stamp";

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
