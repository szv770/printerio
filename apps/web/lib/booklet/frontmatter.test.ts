import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import fontkit from "@pdf-lib/fontkit";
import { drawableRuns } from "./frontmatter";
import { visualOrder } from "./bidi";
import { DAVID_LIBRE_REGULAR_BASE64 } from "./fonts/david-libre-regular";

// The font library reverses Hebrew runs itself. What lands on the page is whatever its layout returns for the text we
// hand to drawText, so this checks the glyphs that really get drawn, left to right, against the visual order we want.
const font = fontkit.create(Buffer.from(DAVID_LIBRE_REGULAR_BASE64, "base64")) as unknown as {
  glyphForCodePoint(cp: number): { id: number };
  layout(text: string): { glyphs: { id: number }[] };
};
const wanted = (visual: string) => Array.from(visual).map((c) => font.glyphForCodePoint(c.codePointAt(0)!).id);
const drawn = (logical: string, dir: "ltr" | "rtl") =>
  drawableRuns(logical, dir).flatMap((r) => font.layout(r.draw).glyphs.map((g) => g.id));

describe("Hebrew is drawn in the order a reader expects", () => {
  it("puts the first letter of a Hebrew word at the right edge", () => {
    // Left to right on the page the word must read א ר י ו, so that a person reading from the right sees וירא.
    expect(drawn("וירא", "rtl")).toEqual(wanted("אריו"));
  });

  it("matches the visual order for the contents heading, titles with numbers, brackets and English", () => {
    for (const text of ["תוכן ענינים", "שיחה א - ליקוטי שיחות חלק ה", "וירא - חלק ג 4", "באתי לגני (ה'תשי\"א) - Likkutei Sichos", "Proceeding Together, Vol. 3 - Rosh Hashanah"]) {
      expect(drawn(text, "rtl"), text).toEqual(wanted(visualOrder(text, "rtl")));
    }
  });

  it("leaves English lines alone", () => {
    expect(drawn("Contents", "ltr")).toEqual(wanted("Contents"));
  });
});
