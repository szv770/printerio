import { describe, expect, it, vi } from "vitest";
import { makeHebrewPdf, HEBREW_LINES } from "@printio/pdf/test-support/hebrew-fixtures";
import type { PrepareJobParams } from "@printio/pdf/prepare-wire";
import { createPdfPipeline, isPrepareParams, nodeCanPrepare } from "../src/prepare-pipeline.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const signal = () => new AbortController().signal;

const params = (over: Partial<PrepareJobParams["pdf"]> = {}): PrepareJobParams => ({
  v: 1,
  pdf: {
    maxUploadBytes: 50 * 1024 * 1024,
    colorMode: "bw",
    heldReason: null,
    pageRangeText: null,
    booklet: false,
    bookletOptions: { paperSize: "letter", bindingSide: "left", fit: "fill", sheet: "letter" },
    confirmBookletPadding: false,
    stamp: null,
    allowType3Fonts: false,
    logContext: {},
    ...over,
  },
  finish: { originalFileName: "t.pdf", options: { printerProfileId: "p1", choices: {}, colorMode: "bw", paperSize: "letter", punch: false, confirmBookletPadding: false } },
});
const pages = (n: number) => Array.from({ length: n }, (_, i) => [`${HEBREW_LINES[0]} ${i + 1}`]);

describe("nodeCanPrepare", () => {
  it("needs Node 22.13 or newer", () => {
    expect(nodeCanPrepare("20.18.0")).toBe(false);
    expect(nodeCanPrepare("22.12.9")).toBe(false);
    expect(nodeCanPrepare("22.13.0")).toBe(true);
    expect(nodeCanPrepare("22.23.4")).toBe(true);
    expect(nodeCanPrepare("24.0.0")).toBe(true);
  });
});

describe("isPrepareParams", () => {
  it("accepts real params and refuses anything else", () => {
    expect(isPrepareParams(params())).toBe(true);
    for (const junk of [null, 5, "x", {}, { v: 2, pdf: {} }, { v: 1 }, { v: 1, pdf: { colorMode: "bw" } }]) expect(isPrepareParams(junk)).toBe(false);
  });
});

describe("the PDF pipeline", () => {
  const run = (original: Uint8Array, p: unknown) => createPdfPipeline(logger)({ original, params: p, signal: signal() });

  it("an ordinary PDF needs no changes: counts reported, nothing to upload (the original prints as it is), no storage path", async () => {
    const out = await run(await makeHebrewPdf({ pages: pages(3) }), params());
    expect(out.kind).toBe("prepared");
    if (out.kind !== "prepared") return;
    expect(out.result).toMatchObject({ sourcePages: 3, effectivePageCount: 3, held: false, pictureCopy: false });
    expect(out.result.fileSizeBytes).toBeGreaterThan(0);
    expect("preparedPath" in out.result).toBe(false);
    expect(out.bytes).toBeNull();
  });

  it("a PDF with attachments and scripts comes back cleaned, as a real PDF to upload", async () => {
    const out = await run(await makeHebrewPdf({ pages: pages(2), active: true }), params());
    expect(out.kind).toBe("prepared");
    if (out.kind !== "prepared") return;
    expect(out.bytes).not.toBeNull();
    expect(Buffer.from(out.bytes!.slice(0, 5)).toString()).toBe("%PDF-");
    expect(Buffer.from(out.bytes!).toString("latin1")).not.toContain("/JavaScript");
  });

  it("a page range keeps only those pages", async () => {
    const out = await run(await makeHebrewPdf({ pages: pages(5) }), params({ pageRangeText: "2-3" }));
    expect(out.kind === "prepared" && out.result).toMatchObject({ sourcePages: 2, effectivePageCount: 2, pageRangeText: "2-3" });
  });

  it("a held job reports it and uploads nothing", async () => {
    const out = await run(await makeHebrewPdf({ pages: pages(1) }), params({ heldReason: "Needs approval" }));
    expect(out.kind === "prepared" && out.result.held).toBe(true);
    expect(out.kind === "prepared" && out.bytes).toBeNull();
  });

  it("a bad page range comes back as an error next to its field, with nothing to upload", async () => {
    const out = await run(await makeHebrewPdf({ pages: pages(2) }), params({ pageRangeText: "9-12" }));
    expect(out.kind === "prepared" && out.result.error).toMatchObject({ code: "invalid_page_range" });
    expect(out.kind === "prepared" && out.bytes).toBeNull();
  });

  it("a file that is not a PDF is an error, not a crash", async () => {
    const out = await run(new TextEncoder().encode("this is not a pdf"), params());
    expect(out.kind === "prepared" && out.result.error).toMatchObject({ code: "bad_pdf" });
  });

  it("a booklet that needs blank pages asks first, and goes ahead once confirmed", async () => {
    const original = await makeHebrewPdf({ pages: pages(5) });
    const asks = await run(original, params({ booklet: true }));
    expect(asks.kind === "prepared" && asks.result.needsBookletConfirm).toMatchObject({ sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 });
    const done = await run(original, params({ booklet: true, confirmBookletPadding: true }));
    expect(done.kind === "prepared" && done.result).toMatchObject({ effectivePageCount: 8, bookletPaddingAdded: 3 });
  });

  it("params from a newer website are refused with a plain message telling the admin to update", async () => {
    const out = await run(await makeHebrewPdf({ pages: pages(1) }), { v: 2 });
    expect(out).toMatchObject({ kind: "rejected", reason: expect.stringContaining("out of date") });
  });

  it("stops if the job was dropped while it worked", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createPdfPipeline(logger)({ original: await makeHebrewPdf({ pages: pages(1) }), params: params(), signal: ac.signal })).rejects.toThrow("aborted");
  });
});
