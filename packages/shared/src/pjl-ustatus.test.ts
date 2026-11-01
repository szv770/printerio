import { describe, expect, it } from "vitest";
import {
  UstatusFeedback,
  expectedRawPages,
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
  it("reads the job start, a page (page) count and a device state", () => {
    const { reports, rest } = parseUstatus(START + page(1) + device(10023, "Processing..."));
    expect(reports).toEqual([
      { kind: "job_start", name: "Report.pdf" },
      { kind: "page", pages: 1 },
      { kind: "device", code: 10023, display: "Processing..." },
    ]);
    expect(rest).toBe("");
  });
  it("several PAGE messages in one chunk", () => {
    const { reports } = parseUstatus(page(1) + page(2) + page(3));
    expect(reports.map((r) => (r.kind === "page" ? r.pages : -1))).toEqual([1, 2, 3]);
  });
  it("a message split mid-way is kept in rest and completed by the next chunk", () => {
    const whole = page(7);
    for (let cut = 1; cut < whole.length; cut++) {
      const a = parseUstatus(whole.slice(0, cut));
      const b = parseUstatus(a.rest + whole.slice(cut));
      expect([...a.reports, ...b.reports]).toEqual([{ kind: "page", pages: 7 }]);
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
    expect(isAttentionCode(35078)).toBe(false); // "Sleeping...": a normal state the printer reports when idle (docs/kyocera-raw-print.md)
    expect(isAttentionCode(40022)).toBe(true);
    expect(isAttentionCode(undefined)).toBe(false);
  });
});

describe("UstatusFeedback", () => {
  it("counts pages and completes at the expected number", () => {
    const f = new UstatusFeedback(3);
    f.push(START + page(1));
    expect(f.pages).toBe(1);
    expect(f.complete).toBe(false);
    f.push(page(2) + page(3));
    expect(f.pages).toBe(3);
    expect(f.complete).toBe(true);
  });
  it("ignores a page number that goes backwards", () => {
    const f = new UstatusFeedback(5);
    f.push(page(3) + page(1));
    expect(f.pages).toBe(3);
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

describe("expectedRawPages (PAGE counts printed sides, measured 2026-11-01)", () => {
  it("plain job: copies x pages sent, duplex or not (one PAGE per side)", () => {
    expect(expectedRawPages({ sourcePages: 4, copies: 2, booklet: false, bookletPaddingAdded: 0 })).toBe(8);
    expect(expectedRawPages({ sourcePages: 6, copies: 1, booklet: false, bookletPaddingAdded: 0 })).toBe(6);
  });
  it("booklet: the imposed PDF has two logical pages per side: ceil(padded / 2) x copies", () => {
    expect(expectedRawPages({ sourcePages: 6, copies: 3, booklet: true, bookletPaddingAdded: 2 })).toBe(12);
    expect(expectedRawPages({ sourcePages: 8, copies: 1, booklet: true, bookletPaddingAdded: 0 })).toBe(4);
  });
});

describe("JOB END", () => {
  const end = (n: number) => `@PJL USTATUS JOB\r\nEND\r\nNAME="My Job"\r\nPAGES=${n}\r\n\f`;
  it("is parsed with its PAGES number, also in a chunk with PAGE messages", () => {
    expect(parseUstatus(page(7) + page(8) + end(8)).reports).toEqual([
      { kind: "page", pages: 7 },
      { kind: "page", pages: 8 },
      { kind: "job_end", name: "My Job", pages: 8 },
    ]);
  });
  it("completes the feedback at once, with the PAGES number, even if fewer PAGE messages came", () => {
    const f = new UstatusFeedback(8);
    f.push(page(1) + page(2));
    expect(f.complete).toBe(false);
    f.push(end(8));
    expect(f.complete).toBe(true);
    expect(f.pages).toBe(8);
  });
  it("odd page count in duplex: >= expected is enough (never require the blank back)", () => {
    const f = new UstatusFeedback(5);
    f.push(page(5));
    expect(f.complete).toBe(true);
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
