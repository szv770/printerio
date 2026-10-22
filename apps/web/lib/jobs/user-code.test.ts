import { describe, expect, it } from "vitest";
import { buildStampText, generateUserCode, normalizeStampSettings, normalizeUserCode, userCodeCandidates } from "./user-code";

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

const DB_RE = /^[A-Z0-9]{1,12}$/;
const gen = (displayName: string | null, used: string[] = [], email: string | null = null) => generateUserCode({ displayName, email }, used);

describe("generateUserCode", () => {
  it("uses first + last initials when free", () => {
    expect(gen("Sam Vogel")).toBe("SV");
    expect(gen("sam vogel")).toBe("SV");
  });
  it("uses first and last word only (middle names ignored)", () => {
    expect(gen("Sam Michael Vogel")).toBe("SV");
  });
  it("single names use their first two letters", () => {
    expect(gen("Moshe")).toBe("MO");
    expect(gen("X")).toBe("X");
  });
  it("on a collision adds one more letter: remaining letters of the first name, then of the last, in order", () => {
    expect(gen("Sam Vogel", ["SV"])).toBe("SVA");
    expect(gen("Sam Vogel", ["SV", "SVA"])).toBe("SVM");
    expect(gen("Sam Vogel", ["SV", "SVA", "SVM"])).toBe("SVO");
    expect(gen("Sam Vogel", ["SV", "SVA", "SVM", "SVO", "SVG", "SVE"])).toBe("SVL");
  });
  it("single names extend with their remaining letters", () => {
    expect(gen("Moshe", ["MO"])).toBe("MOS");
    expect(gen("Moshe", ["MO", "MOS", "MOH"])).toBe("MOE");
  });
  it("when every letter option is taken it appends 1, 2, 3...", () => {
    const used = ["SV", "SVA", "SVM", "SVO", "SVG", "SVE", "SVL"];
    expect(gen("Sam Vogel", used)).toBe("SV1");
    expect(gen("Sam Vogel", [...used, "SV1", "SV2"])).toBe("SV3");
  });
  it("skips repeated letters instead of proposing a candidate twice", () => {
    // Anna Aaron: initials AA, extra letters n,n,a (Anna) then a,r,o,n (Aaron) -> AAN, AAA, AAR, AAO
    expect(gen("Anna Aaron", ["AA"])).toBe("AAN");
    expect(gen("Anna Aaron", ["AA", "AAN"])).toBe("AAA");
  });
  it("is case-insensitive about used codes", () => {
    expect(gen("Sam Vogel", ["sv"])).toBe("SVA");
    expect(gen("Sam Vogel", ["Sv", "sva"])).toBe("SVM");
  });
  it("strips non-letters, accents and digits from names", () => {
    expect(gen("Zoë O'Brien-Smith")).toBe("ZS");
    expect(gen("  José  Álvarez ")).toBe("JA");
    expect(gen("R2-D2")).toBe("RD");
  });
  it("falls back to the email local part when the name has no Latin letters", () => {
    expect(gen(null, [], "rivka.cohen@school.org")).toBe("RC");
    expect(gen("", [], "moshe@school.org")).toBe("MO");
    expect(gen("שרה כהן", [], "dana.levi@x.org")).toBe("DL");
  });
  it("no usable Latin letters at all (Hebrew name, no email) -> U + number, skipping used ones", () => {
    expect(gen("שרה כהן")).toBe("U1");
    expect(gen("שרה כהן", ["U1", "U2"])).toBe("U3");
    expect(gen(null, ["u1"], null)).toBe("U2");
    expect(gen("123", [], "456@x.org")).toBe("U1");
  });
  it("never repeats a code across many people with the same initials", () => {
    const used = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const code = generateUserCode({ displayName: "Sam Vogel", email: null }, used);
      expect(DB_RE.test(code)).toBe(true);
      expect(used.has(code)).toBe(false);
      used.add(code);
    }
    expect(used.size).toBe(600);
  });
  it("never repeats a code across many nameless people", () => {
    const used = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const code = generateUserCode({ displayName: "שרה", email: null }, used);
      expect(used.has(code)).toBe(false);
      used.add(code);
    }
  });
  it("always fits the DB check ^[A-Z0-9]{1,12}$, even for very long names", () => {
    const long = "Abcdefghijklmnopqrstuvwxyz Zyxwvutsrqponmlkjihgfedcba";
    const used = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode({ displayName: long, email: null }, used);
      expect(DB_RE.test(code)).toBe(true);
      used.add(code);
    }
  });
  it("candidates are lazy, unique and all valid", () => {
    const first = [...take(userCodeCandidates({ displayName: "Sam Vogel", email: null }), 40)];
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((c) => DB_RE.test(c))).toBe(true);
    expect(first.slice(0, 3)).toEqual(["SV", "SVA", "SVM"]);
  });
});

function* take<T>(it: Iterable<T>, n: number): Generator<T> {
  let i = 0;
  for (const v of it) {
    if (i++ >= n) return;
    yield v;
  }
}

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
