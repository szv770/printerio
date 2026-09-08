import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createTestPrintPdf, formatTestPrintTimestamp, toWinAnsiSafe } from "./test-print";
import { preflightPdf } from "./preflight";

const BASE_INPUT = {
  profileLabel: "Booklet + Staple",
  windowsQueueName: "Kyocera_Main_Booklet",
  printerName: "Main Office Kyocera",
  sentBy: "Sam Vogel",
  organizationName: "Lakeside School",
  jobId: "8f14e45f-ceea-467a-9f2c-1b2c3d4e5f60",
  sentAt: new Date("2026-09-07T14:03:27Z"),
  paperSize: "letter",
};

describe("createTestPrintPdf", () => {
  it("produces a single-page PDF at the requested sheet size", async () => {
    const bytes = await createTestPrintPdf(BASE_INPUT);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(612);
    expect(Math.round(height)).toBe(792);
  });

  it("honours the target profile's paper size rather than always using letter", async () => {
    const bytes = await createTestPrintPdf({ ...BASE_INPUT, paperSize: "a4" });
    const doc = await PDFDocument.load(bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
  });

  it("passes the same preflight every real upload goes through", async () => {
    const bytes = await createTestPrintPdf(BASE_INPUT);
    const result = await preflightPdf(bytes, { maxSizeBytes: 52_428_800 });
    expect(result).toMatchObject({ ok: true, pageCount: 1 });
  });

  // pdf-lib's standard fonts throw on any character they cannot encode, so a
  // Hebrew display name or an emoji in a label must not be able to take the
  // whole test print down with it (this org explicitly has RTL users - see
  // docs/architecture.md sec 8).
  it("does not throw on text outside the standard font's encoding", async () => {
    const bytes = await createTestPrintPdf({
      ...BASE_INPUT,
      profileLabel: "חוברת",
      sentBy: "🖨️ Admin",
      printerName: "Kyocera – front office",
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("survives an absurdly long label without failing", async () => {
    const bytes = await createTestPrintPdf({ ...BASE_INPUT, profileLabel: "x".repeat(4000) });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});

describe("toWinAnsiSafe", () => {
  it("keeps ASCII and Latin-1 text unchanged", () => {
    expect(toWinAnsiSafe("Kyocera_Main (café) - 11x17")).toBe("Kyocera_Main (café) - 11x17");
  });

  it("replaces characters the standard fonts cannot encode", () => {
    expect(toWinAnsiSafe("חוברת")).toBe("?????");
    // U+2003 EM SPACE - outside WinAnsi, and exactly the kind of character
    // that arrives in a label pasted from a document without anyone noticing.
    expect(toWinAnsiSafe("a\u2003b")).toBe("a?b");
  });
});

describe("formatTestPrintTimestamp", () => {
  it("formats in UTC, independent of the rendering machine's locale", () => {
    expect(formatTestPrintTimestamp(new Date("2026-09-07T14:03:27Z"))).toBe("2026-09-07 14:03 UTC");
    expect(formatTestPrintTimestamp(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04 UTC");
  });
});
