import { describe, expect, it } from "vitest";
import { classifyPrinterStatus, parsePjlInfoStatus, sanitizePrinterDisplay } from "./pjl-status";

describe("parsePjlInfoStatus (the answer to @PJL INFO STATUS)", () => {
  it("reads the real Kyocera TASKalfa MZ8500i answer", () => {
    expect(parsePjlInfoStatus('@PJL INFO STATUS\r\nCODE=10023\r\nDISPLAY="Processing..."\r\nONLINE=TRUE\r\n\f')).toEqual({ code: 10023, display: "Processing...", online: true });
  });
  it("reads an offline printer and an answer with a problem message", () => {
    expect(parsePjlInfoStatus('@PJL INFO STATUS\r\nCODE=40022\r\nDISPLAY="Add paper in cassette 2"\r\nONLINE=FALSE\r\n\f')).toEqual({ code: 40022, display: "Add paper in cassette 2", online: false });
  });
  it("copes with missing parts, odd spacing and other text around it", () => {
    expect(parsePjlInfoStatus("@PJL INFO STATUS\r\nCODE=10001\r\n")).toEqual({ code: 10001 });
    expect(parsePjlInfoStatus('garbage CODE = 10001 \r\n DISPLAY = "Ready" ONLINE = true')).toEqual({ code: 10001, display: "Ready", online: true });
  });
  it("returns null when there is nothing it understands", () => {
    expect(parsePjlInfoStatus("")).toBeNull();
    expect(parsePjlInfoStatus("@PJL INFO ID\r\n\"TASKalfa MZ8500i\"\r\n\f")).toBeNull();
  });
});

describe("sanitizePrinterDisplay (the printer's own words are shown to people)", () => {
  it("removes control characters and extra spaces and limits the length", () => {
    expect(sanitizePrinterDisplay("  Add\u0007 paper \u001b[31m in\r\ncassette 1 ")).toBe("Add paper [31m in cassette 1");
    expect(sanitizePrinterDisplay("x".repeat(500))!.length).toBeLessThanOrEqual(120);
    expect(sanitizePrinterDisplay(undefined)).toBeUndefined();
    expect(sanitizePrinterDisplay("   ")).toBeUndefined();
  });
});

describe("classifyPrinterStatus (what a PJL status code means for people waiting)", () => {
  const c = (code: number | undefined, extra: Record<string, unknown> = {}) => classifyPrinterStatus({ reachable: true, answered: true, code, ...extra });
  it("10xxx is the printer working normally: ready, or busy processing", () => {
    expect(c(10001).level).toBe("ok");
    expect(c(10023, { display: "Processing..." }).level).toBe("ok");
    expect(c(10002).needsAttention).toBe(false);
  });
  it("30xxx and 35xxx are warnings the printer can keep going through", () => {
    expect(c(30016, { display: "Toner low" })).toMatchObject({ level: "warning", needsAttention: false });
    expect(c(35078).level).toBe("warning");
  });
  it("40xxx to 49xxx need someone at the printer (paper out, jam, door open)", () => {
    expect(c(40022, { display: "Add paper" })).toMatchObject({ level: "attention", needsAttention: true });
    expect(c(42001).level).toBe("attention");
  });
  it("50xxx is a hardware error", () => {
    expect(c(50001)).toMatchObject({ level: "error", needsAttention: true });
  });
  it("offline wins over any code, and an unreachable or silent printer is not called a problem it cannot prove", () => {
    expect(c(10001, { online: false }).level).toBe("offline");
    expect(classifyPrinterStatus({ reachable: false, answered: false })).toMatchObject({ level: "offline", needsAttention: true });
    expect(classifyPrinterStatus({ reachable: true, answered: false })).toMatchObject({ level: "unknown", needsAttention: false });
    expect(c(undefined).level).toBe("unknown");
  });
});
