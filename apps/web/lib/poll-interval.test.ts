import { describe, expect, it } from "vitest";
import { POLL_PRESETS, parsePollSeconds } from "./poll-interval";

describe("parsePollSeconds", () => {
  it("blank means use the PC's own setting", () => {
    expect(parsePollSeconds("")).toEqual({ ok: true, value: null });
    expect(parsePollSeconds("default")).toEqual({ ok: true, value: null });
  });
  it("accepts whole seconds from 2 to 300", () => {
    expect(parsePollSeconds("3")).toEqual({ ok: true, value: 3 });
    expect(parsePollSeconds("300")).toEqual({ ok: true, value: 300 });
  });
  it("refuses anything else", () => {
    for (const bad of ["1", "301", "2.5", "abc", "-5", "0"]) expect(parsePollSeconds(bad).ok).toBe(false);
  });
  it("every preset is valid", () => {
    for (const p of POLL_PRESETS) expect(parsePollSeconds(String(p.seconds)).ok).toBe(true);
  });
});
