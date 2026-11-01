import { describe, expect, it } from "vitest";
import {
  UstatusFeedback,
  expectedRawSheets,
  formatPrinterErrorMarker,
  isAttentionCode,
  parsePrinterErrorMarker,
  parseUstatus,
  printerErrorDetail,
} from "./pjl-ustatus";

// Byte formats MEASURED on the TASKalfa MZ8500i, port 9100 (docs/kyocera-raw-print.md, 2026-11-01).
const START = '@PJL USTATUS JOB\r\nSTART\r\nNAME="Report.pdf"\r\n\f';
const page = (n: number) => `@PJL USTATUS PAGE\r\n${n}\n\r\n\f`;
const device = (code: number, text: string) => `@PJL USTATUS DEVICE\r\nCODE=${code}\r\nDISPLAY="${text}"\r\nONLINE=TRUE\r\n\f`;

describe("parseUstatus (measured formats)", () => {
  it("reads the job start, a page (sheet) count and a device state", () => {
    const { reports, rest } = parseUstatus(START + page(1) + device(10023, "Processing..."));
    expect(reports).toEqual([
      { kind: "job_start", name: "Report.pdf" },
      { kind: "page", sheets: 1 },
      { kind: "device", code: 10023, display: "Processing..." },
    ]);
    expect(rest).toBe("");
  });
  it("several PAGE messages in one chunk", () => {
    const { reports } = parseUstatus(page(1) + page(2) + page(3));
    expect(reports.map((r) => (r.kind === "page" ? r.sheets : -1))).toEqual([1, 2, 3]);
  });
  it("a message split mid-way is kept in rest and completed by the next chunk", () => {
    const whole = page(7);
    for (let cut = 1; cut < whole.length; cut++) {
      const a = parseUstatus(whole.slice(0, cut));
      const b = parseUstatus(a.rest + whole.slice(cut));
      expect([...a.reports, ...b.reports]).toEqual([{ kind: "page", sheets: 7 }]);
    }
  });
  it("garbage and unknown frames are ignored, never thrown", () => {
    expect(parseUstatus("\x00\xff garbage @PJL USTATUS WAT\r\nX=1\r\n\f").reports).toEqual([]);
    expect(parseUstatus("@PJL USTATUS PAGE\r\nabc\r\n\f").reports).toEqual([]);
    expect(parseUstatus("").reports).toEqual([]);
  });
  it("printer text is sanitised", () => {
    const r = parseUstatus('@PJL USTATUS DEVICE\r\nCODE=40022\r\nDISPLAY="Jam <b>in</b> tray\x1b[1m"\r\n\f').reports[0];
    expect(r).toMatchObject({ kind: "device", code: 40022 });
    expect((r as { display: string }).display).not.toMatch(/[<>\x1b]/);
  });
});

describe("isAttentionCode", () => {
  it("10xxx is normal, everything else needs attention, no code is not attention", () => {
    expect(isAttentionCode(10001)).toBe(false);
    expect(isAttentionCode(10023)).toBe(false);
    expect(isAttentionCode(10999)).toBe(false);
    expect(isAttentionCode(40022)).toBe(true);
    expect(isAttentionCode(35078)).toBe(true);
    expect(isAttentionCode(undefined)).toBe(false);
  });
});

describe("UstatusFeedback", () => {
  it("counts sheets and completes at the expected number", () => {
    const f = new UstatusFeedback(3);
    f.push(START + page(1));
    expect(f.sheets).toBe(1);
    expect(f.complete).toBe(false);
    f.push(page(2) + page(3));
    expect(f.sheets).toBe(3);
    expect(f.complete).toBe(true);
  });
  it("ignores a sheet number that goes backwards", () => {
    const f = new UstatusFeedback(5);
    f.push(page(3) + page(1));
    expect(f.sheets).toBe(3);
  });
  it("attention is the LATEST device state: raised by a non-10xxx code and cleared by a 10xxx one", () => {
    const f = new UstatusFeedback(2);
    f.push(device(10023, "Processing..."));
    expect(f.attention).toBeNull();
    f.push(device(40022, "Paper jam"));
    expect(f.attention).toEqual({ code: 40022, text: "Paper jam" });
    f.push(device(10023, "Processing..."));
    expect(f.attention).toBeNull();
  });
  it("works across split chunks", () => {
    const f = new UstatusFeedback(1);
    const s = START + page(1);
    f.push(s.slice(0, 50));
    f.push(s.slice(50));
    expect(f.complete).toBe(true);
  });
  it("an expected count of 0 is never complete by itself (feedback needs a positive count)", () => {
    expect(new UstatusFeedback(0).complete).toBe(false);
  });
});

describe("expectedRawSheets", () => {
  it("plain job: copies x (duplex ? ceil(pages/2) : pages)", () => {
    expect(expectedRawSheets({ pageCount: 4, copies: 2, duplex: true, booklet: false })).toBe(4);
    expect(expectedRawSheets({ pageCount: 5, copies: 1, duplex: true, booklet: false })).toBe(3);
    expect(expectedRawSheets({ pageCount: 5, copies: 3, duplex: false, booklet: false })).toBe(15);
  });
  it("booklet: imposed sheets x copies", () => {
    expect(expectedRawSheets({ pageCount: 8, copies: 2, duplex: true, booklet: true })).toBe(4);
  });
});

describe("printer-attention marker", () => {
  it("round-trips the printer's words", () => {
    const m = formatPrinterErrorMarker({ code: 40022, text: "Paper jam" });
    expect(m).toBe("[printio:printer-error v1 code=40022] Paper jam");
    expect(parsePrinterErrorMarker(m)).toEqual({ code: 40022, text: "Paper jam" });
    expect(parsePrinterErrorMarker("raw print: boom")).toBeNull();
    expect(parsePrinterErrorMarker(null)).toBeNull();
  });
  it("detail tells the owner the job may still print", () => {
    expect(printerErrorDetail({ code: 1, text: "Paper jam." })).toMatch(/^Paper jam\. .*may still print/);
  });
});
