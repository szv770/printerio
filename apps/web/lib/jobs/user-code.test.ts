import { describe, expect, it } from "vitest";
import { buildStampText, effectiveUserCode, fallbackUserCode, normalizeStampSettings, normalizeUserCode } from "./user-code";

describe("normalizeUserCode", () => {
  it("accepts initials + digits, uppercases and trims", () => {
    expect(normalizeUserCode("  sv42 ")).toBe("SV42");
  });
  it("rejects empty, too long, or odd characters", () => {
    expect(normalizeUserCode("")).toBeNull();
    expect(normalizeUserCode("A".repeat(13))).toBeNull();
    expect(normalizeUserCode("a b")).toBeNull();
    expect(normalizeUserCode("é1")).toBeNull();
  });
});

describe("fallbackUserCode / effectiveUserCode", () => {
  const userId = "8f14e45f-ceea-467a-9f2c-1b2c3d4e5f60";
  it("uses initials of the display name plus two stable digits", () => {
    const a = fallbackUserCode({ displayName: "Sam Vogel", email: "x@y.z", userId });
    expect(a).toMatch(/^SV\d\d$/);
    expect(fallbackUserCode({ displayName: "Sam Vogel", email: "x@y.z", userId })).toBe(a);
  });
  it("falls back to the email local part when there is no name", () => {
    expect(fallbackUserCode({ displayName: null, email: "rivka.cohen@school.org", userId })).toMatch(/^RC\d\d$/);
  });
  it("falls back to U when there is nothing at all", () => {
    expect(fallbackUserCode({ displayName: null, email: null, userId })).toMatch(/^U\d\d$/);
  });
  it("prefers the stored code and reports when it generated one", () => {
    expect(effectiveUserCode({ stored: "sv07", displayName: "A B", email: null, userId })).toEqual({ code: "SV07", generated: false });
    const g = effectiveUserCode({ stored: null, displayName: "A B", email: null, userId });
    expect(g.generated).toBe(true);
    expect(g.code).toMatch(/^AB\d\d$/);
  });
});

describe("buildStampText", () => {
  it("is the code alone by default", () => {
    expect(buildStampText({ code: "SV42", show: "code", now: new Date("2026-10-22T10:00:00Z") })).toBe("SV42");
  });
  it("can add the date", () => {
    expect(buildStampText({ code: "SV42", show: "code_date", now: new Date("2026-10-22T10:00:00Z") })).toBe("SV42 2026-10-22");
  });
});

describe("normalizeStampSettings", () => {
  it("defaults to ON, code only, light", () => {
    expect(normalizeStampSettings(null)).toEqual({ enabled: true, show: "code", strength: "light" });
    expect(normalizeStampSettings({})).toEqual({ enabled: true, show: "code", strength: "light" });
  });
  it("reads the columns and ignores junk values", () => {
    expect(normalizeStampSettings({ stamp_enabled: false, stamp_show: "code_date", stamp_strength: "strong" })).toEqual({
      enabled: false,
      show: "code_date",
      strength: "strong",
    });
    expect(normalizeStampSettings({ stamp_show: "zzz", stamp_strength: "zzz" })).toEqual({ enabled: true, show: "code", strength: "light" });
  });
});
