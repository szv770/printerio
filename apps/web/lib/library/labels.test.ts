import { describe, expect, it } from "vitest";
import { friendlyFileLabel, hasEnglish, matchesQuery } from "./labels";

describe("friendlyFileLabel", () => {
  it("turns the library's short Hebrew button names into plain words", () => {
    expect(friendlyFileLabel("שיחה")).toBe("Hebrew sicha");
    expect(friendlyFileLabel("מתורגם")).toBe("English translation");
    expect(friendlyFileLabel("  מתורגם ")).toBe("English translation");
  });
  it("leaves every other label as it is", () => {
    expect(friendlyFileLabel('שיחו"ק')).toBe('שיחו"ק');
    expect(friendlyFileLabel("Proceeding Together Vol. 3")).toBe("Proceeding Together Vol. 3");
    expect(friendlyFileLabel("")).toBe("");
  });
});

describe("hasEnglish", () => {
  it("is true when a file is a translation or the section is English", () => {
    expect(hasEnglish([{ label: "שיחה" }, { label: "מתורגם" }])).toBe(true);
    expect(hasEnglish([{ label: "Proceeding Together Vol. 3" }], "English")).toBe(true);
    expect(hasEnglish([{ label: "English translation" }])).toBe(true);
  });
  it("is false otherwise", () => {
    expect(hasEnglish([{ label: "שיחה" }])).toBe(false);
    expect(hasEnglish([], "הנחות")).toBe(false);
  });
});

describe("matchesQuery", () => {
  it("matches words anywhere in the text, ignoring case, quotes and extra spaces", () => {
    expect(matchesQuery(["ח\"א ע' 1 (בראשית)", "בריאה יש מאין"], "בראשית")).toBe(true);
    expect(matchesQuery(["Likkutei Sichos vol 5"], "  sichos   VOL ")).toBe(true);
    expect(matchesQuery(['ח"א ע\' 15'], "ח״א")).toBe(true); // typographic quotes match the plain ones
  });
  it("needs every word to match, and an empty search matches everything", () => {
    expect(matchesQuery(["נח (מבול)"], "נח לך")).toBe(false);
    expect(matchesQuery(["anything"], "")).toBe(true);
    expect(matchesQuery([], "x")).toBe(false);
  });
});
