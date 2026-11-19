import { describe, expect, it } from "vitest";
import type { PreparePdfResult } from "./prepare";
import { prepareInputFromParams, readWire, toWire, type PrepareJobParams } from "./prepare-wire";

const params: PrepareJobParams = {
  v: 1,
  pdf: {
    maxUploadBytes: 1000,
    colorMode: "bw",
    heldReason: null,
    pageRangeText: "1-2",
    booklet: false,
    bookletOptions: { paperSize: "letter", bindingSide: "left", fit: "fill", sheet: "letter" },
    confirmBookletPadding: false,
    stamp: { text: "SV42", strength: "light" },
    allowType3Fonts: false,
    logContext: { organizationId: "o" },
  },
  finish: { originalFileName: "r.pdf", options: { printerProfileId: "p", choices: {}, colorMode: "bw", paperSize: "letter", punch: false, confirmBookletPadding: false } },
};

const ok = (over: Partial<Extract<PreparePdfResult, { ok: true }>> = {}): PreparePdfResult => ({
  ok: true, held: false, heldReason: null, derivedBytes: new Uint8Array([1]), effectivePageCount: 8, blankPagesAdded: 3, sourcePages: 5, pageRangeText: null, fileSizeBytes: 999, pictureCopy: false, ...over,
});

describe("prepare wire format", () => {
  it("the print server gets exactly the PDF inputs from a job's params (never the website-only finish part)", () => {
    const input = prepareInputFromParams(params);
    expect(input).toMatchObject({ maxUploadBytes: 1000, pageRangeText: "1-2", stamp: { text: "SV42", strength: "light" }, allowType3Fonts: false });
    expect(JSON.stringify(input)).not.toContain("originalFileName");
    expect("forcedHeldReason" in input).toBe(false);
    expect(prepareInputFromParams({ ...params, pdf: { ...params.pdf, forcedHeldReason: "x" } }).forcedHeldReason).toBe("x");
  });

  it("a prepared job survives the round trip: everything the finish step needs, and no bytes", () => {
    const wire = toWire(ok(), "prepared/o/j/x.pdf");
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire); // plain JSON
    const read = readWire(wire);
    expect(read).toMatchObject({
      kind: "prepared",
      preparedPath: "prepared/o/j/x.pdf",
      prepared: { ok: true, held: false, heldReason: null, derivedBytes: null, effectivePageCount: 8, blankPagesAdded: 3, sourcePages: 5, pageRangeText: null, fileSizeBytes: 999, pictureCopy: false },
    });
  });

  it("a held job keeps its reason and has no prepared file", () => {
    const read = readWire(toWire(ok({ held: true, heldReason: "Choose a side.", derivedBytes: null }), null));
    expect(read).toMatchObject({ kind: "prepared", preparedPath: null, prepared: { held: true, heldReason: "Choose a side." } });
  });

  it("inline errors keep their code and the field they belong to", () => {
    const wire = toWire({ ok: false, kind: "error", code: "invalid_page_range", error: "The document only has 5 pages.", fieldErrors: { pageRange: "The document only has 5 pages." } }, null);
    expect(readWire(wire)).toEqual({ kind: "error", error: { code: "invalid_page_range", message: "The document only has 5 pages.", fieldErrors: { pageRange: "The document only has 5 pages." } } });
  });

  it("a booklet that needs blank pages confirmed travels as its own outcome", () => {
    const wire = toWire({ ok: false, kind: "needs_booklet_confirm", needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } }, null);
    expect(readWire(wire)).toEqual({ kind: "needs_booklet_confirm", needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } });
  });

  it("a rejected file wins, and a result without the finish fields (an older print server) is 'incomplete', never guessed", () => {
    expect(readWire({ preparedPath: null, sourcePages: 0, rejectedReason: "Password protected." })).toEqual({ kind: "rejected", reason: "Password protected." });
    expect(readWire({ preparedPath: null, sourcePages: 3 })).toEqual({ kind: "incomplete" });
  });
});
