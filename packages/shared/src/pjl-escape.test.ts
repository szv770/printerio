import { describe, expect, it } from "vitest";
import { buildRawJob } from "./pjl";
import { containsPjlEscape, createPjlEscapeScanner, PJL_ESCAPE_MESSAGE } from "./pjl-escape";

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const UEL = "\x1b%-12345X";
const clean = enc("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe("containsPjlEscape", () => {
  it("is false for a clean PDF and for empty input", () => {
    expect(containsPjlEscape(clean)).toBe(false);
    expect(containsPjlEscape(new Uint8Array(0))).toBe(false);
  });
  it("finds the UEL at the very start, middle and very end", () => {
    expect(containsPjlEscape(concat(enc(UEL), clean))).toBe(true);
    expect(containsPjlEscape(concat(clean, enc(UEL), clean))).toBe(true);
    expect(containsPjlEscape(concat(clean, enc(UEL)))).toBe(true);
  });
  it("finds lowercase and mixed-case variants of the X", () => {
    expect(containsPjlEscape(concat(clean, enc("\x1b%-12345x@pjl info id")))).toBe(true);
  });
  it("finds ESC followed (closely) by @PJL in any case", () => {
    expect(containsPjlEscape(concat(clean, enc("\x1b@PJL INFO ID")))).toBe(true);
    expect(containsPjlEscape(concat(clean, enc("\x1b%-1@pjl set")))).toBe(true);
    expect(containsPjlEscape(concat(clean, enc("\x1b  @PjL")))).toBe(true);
  });
  it("does not trip on ESC alone, or on @PJL text with no ESC before it", () => {
    expect(containsPjlEscape(concat(clean, enc("\x1b[0m hello")))).toBe(false);
    expect(containsPjlEscape(concat(clean, enc("(@PJL is a language) %-12345X")))).toBe(false);
  });
  it("does not trip when @PJL is far after an ESC", () => {
    expect(containsPjlEscape(enc("\x1b" + "a".repeat(40) + "@PJL"))).toBe(false);
  });
  it("scans a 120 MB buffer quickly", () => {
    const big = new Uint8Array(120 * 1024 * 1024).fill(0x41);
    for (let i = 0; i < big.length; i += 4096) big[i] = 0x1b; // many lone ESC bytes
    const t = Date.now();
    expect(containsPjlEscape(big)).toBe(false);
    expect(Date.now() - t).toBeLessThan(3000);
    big.set(enc(UEL), big.length - 20);
    expect(containsPjlEscape(big)).toBe(true);
  });
});

describe("createPjlEscapeScanner (chunked)", () => {
  it("finds the sequence split at every possible boundary", () => {
    const data = concat(clean, enc(UEL + "@PJL INFO ID"), clean);
    for (let cut = 1; cut < data.length; cut++) {
      const s = createPjlEscapeScanner();
      const a = s.push(data.subarray(0, cut));
      const b = s.push(data.subarray(cut));
      expect(a || b, `cut ${cut}`).toBe(true);
    }
  });
  it("finds ESC ... @PJL split across three chunks", () => {
    const s = createPjlEscapeScanner();
    expect(s.push(enc("abc\x1b"))).toBe(false);
    expect(s.push(enc("%-"))).toBe(false);
    expect(s.push(enc("12345X"))).toBe(true);
  });
  it("stays false for a clean stream in many tiny chunks", () => {
    const s = createPjlEscapeScanner();
    let hit = false;
    for (let i = 0; i < clean.length; i++) hit ||= s.push(clean.subarray(i, i + 1));
    expect(hit).toBe(false);
  });
});

describe("buildRawJob defence in depth", () => {
  const base = { copies: 1, colorMode: "color" as const, duplex: true, jobName: "x" };
  it("throws when the document contains a UEL", () => {
    expect(() => buildRawJob(base, concat(clean, enc(UEL + "@PJL INFO ID")))).toThrow(PJL_ESCAPE_MESSAGE);
  });
  it("still builds a clean document", () => {
    expect(buildRawJob(base, clean).ok).toBe(true);
  });
});
