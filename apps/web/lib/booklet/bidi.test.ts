import { describe, expect, it } from "vitest";
import { hasHebrew, paragraphDirection, visualOrder } from "./bidi";

describe("paragraphDirection: the first letter that has a direction decides", () => {
  it("is rtl when the first letter is Hebrew, ltr when it is Latin, and ltr for nothing", () => {
    expect(paragraphDirection("שלום world")).toBe("rtl");
    expect(paragraphDirection("world שלום")).toBe("ltr");
    expect(paragraphDirection("  (123) שלום")).toBe("rtl"); // digits and brackets have no direction of their own: the first LETTER decides
    expect(paragraphDirection("  (123) abc שלום")).toBe("ltr");
    expect(paragraphDirection("(שלום)")).toBe("rtl");
    expect(paragraphDirection("")).toBe("ltr");
    expect(paragraphDirection("123 !!!")).toBe("ltr");
  });
  it("sees Hebrew anywhere with hasHebrew", () => {
    expect(hasHebrew("abc ש")).toBe(true);
    expect(hasHebrew("abc")).toBe(false);
  });
});

describe("visualOrder: the order glyphs are drawn, left to right", () => {
  it("leaves left-to-right text alone", () => {
    expect(visualOrder("Likkutei Sichos vol. 3", "ltr")).toBe("Likkutei Sichos vol. 3");
    expect(visualOrder("", "ltr")).toBe("");
  });

  it("reverses a Hebrew word in a right-to-left line", () => {
    expect(visualOrder("שלום", "rtl")).toBe("םולש");
  });

  it("puts the first word of a right-to-left line on the right, keeping numbers readable", () => {
    // logical: שיחה 5711 ב   -> drawn left to right: ב 5711 החיש
    expect(visualOrder("שיחה 5711 ב", "rtl")).toBe("ב 5711 החיש");
  });

  it("keeps a number with its separators together", () => {
    expect(visualOrder("שיחה 5711-01-01", "rtl")).toBe("5711-01-01 החיש");
    expect(visualOrder("כרך 1,000 עמודים", "rtl")).toBe("םידומע 1,000 ךרכ");
  });

  it("mirrors brackets inside right-to-left text", () => {
    expect(visualOrder("(א)", "rtl")).toBe("(א)");
    expect(visualOrder("שיחה (א) ב", "rtl")).toBe("ב (א) החיש");
  });

  it("a Hebrew word inside a left-to-right line reads right to left, the rest stays put", () => {
    expect(visualOrder("Vol. 3 - שיחה", "ltr")).toBe("Vol. 3 - החיש");
    expect(visualOrder("Parshas Vayera שיחה ב Notes", "ltr")).toBe("Parshas Vayera ב החיש Notes");
  });

  it("an English phrase inside Hebrew keeps its own word order", () => {
    // Drawn left to right: the year (letters reversed) on the far left, then the English phrase, then the first word.
    expect(visualOrder("מאמר Basi Ligani ה'תשי\"א", "rtl")).toBe("א\"ישת'ה Basi Ligani רמאמ");
  });

  it("brackets around English text stay with that English text, even at the end of a Hebrew line", () => {
    expect(visualOrder("באדיבות: Mafteiach (mafteiach.app)", "rtl")).toBe("Mafteiach (mafteiach.app) :תובידאב");
    expect(visualOrder("(Mafteiach) באדיבות", "rtl")).toBe("תובידאב (Mafteiach)");
    // Hebrew inside brackets in a Hebrew line still mirrors
    expect(visualOrder("שיחה (א)", "rtl")).toBe("(א) החיש");
  });

  it("is safe on odd input", () => {
    expect(visualOrder("   ", "rtl")).toBe("   ");
    expect(visualOrder("א", "rtl")).toBe("א");
    expect(visualOrder("!!!", "rtl")).toBe("!!!");
  });
});
