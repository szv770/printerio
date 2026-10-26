import { describe, expect, it } from "vitest";
import { SIE_CREDIT, SIE_WEEKLY } from "./sie-weekly";
import { groupSie, likkutPageFromLabel, sieForLikkut, sieContentRange } from "./sie";
import { normalizeSourceLink } from "@/lib/sources/link";

describe("SIE Weekly data (a snapshot of sie.org/weekly)", () => {
  it("has the published weeks, each with a Drive file that the safe link import accepts", () => {
    expect(SIE_WEEKLY.length).toBeGreaterThan(100);
    for (const e of SIE_WEEKLY) {
      expect(e.title.trim(), JSON.stringify(e)).not.toBe("");
      expect(["Alef", "Beis", "Gimmel", "Daled"]).toContain(e.chelek);
      expect(["Bereishis", "Shmos", "Vayikra", "Bamidbar", "Devarim"]).toContain(e.sefer);
      expect(e.url).toMatch(/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{20,}\/view$/);
      expect(normalizeSourceLink(e.url).ok, e.url).toBe(true);
    }
  });
  it("never repeats a file, and the credit names the source", () => {
    expect(new Set(SIE_WEEKLY.map((e) => e.url)).size).toBe(SIE_WEEKLY.length);
    expect(SIE_CREDIT).toMatch(/Sichos In English/);
  });
});

describe("groupSie", () => {
  const e = (chelek: string, sefer: string, title: string) => ({ chelek, sefer, title, url: `https://drive.google.com/file/d/${title.padEnd(25, "x")}/view` });
  it("groups by volume then book, keeping the order of the list", () => {
    const g = groupSie([e("Alef", "Bereishis", "Bereishis"), e("Alef", "Bereishis", "Noach"), e("Alef", "Shmos", "Shmos"), e("Beis", "Devarim", "Devarim")]);
    expect(g.map((c) => c.chelek)).toEqual(["Alef", "Beis"]);
    expect(g[0]!.sefarim.map((s) => [s.sefer, s.entries.map((x) => x.title)])).toEqual([
      ["Bereishis", ["Bereishis", "Noach"]],
      ["Shmos", ["Shmos"]],
    ]);
  });
  it("filters by a search (title, book or volume) and drops empty groups", () => {
    const list = [e("Alef", "Bereishis", "Noach"), e("Alef", "Shmos", "Bo"), e("Beis", "Devarim", "Vaeschanan")];
    expect(groupSie(list, "noach").flatMap((c) => c.sefarim.flatMap((s) => s.entries.map((x) => x.title)))).toEqual(["Noach"]);
    expect(groupSie(list, "devarim").map((c) => c.chelek)).toEqual(["Beis"]);
    expect(groupSie(list, "zzz")).toEqual([]);
  });
});

describe("likkutPageFromLabel (the page in a Likkutei Sichos entry's label)", () => {
  it("reads the page after ע', with either kind of apostrophe, and ignores the parsha", () => {
    expect(likkutPageFromLabel("ח\"א ע' 1 (בראשית)")).toBe(1);
    expect(likkutPageFromLabel("ח\"א ע׳ 15 (לך לך)")).toBe(15);
    expect(likkutPageFromLabel("חל\"ט ע' 112 (ויצא)")).toBe(112);
  });
  it("is null when there is no page", () => {
    expect(likkutPageFromLabel("ללא עמוד")).toBeNull();
    expect(likkutPageFromLabel("")).toBeNull();
  });
});

describe("sieForLikkut (the English translation of one Likkutei Sichos sicha)", () => {
  const e = (volume: number | undefined, page: number | undefined, title: string) => ({ chelek: "Alef", sefer: "Bereishis", title, url: `https://drive.google.com/file/d/${title.padEnd(25, "x")}/view`, volume, page });
  const list = [e(1, 1, "Bereishis"), e(1, 4, "Noach"), e(2, 4, "Other"), e(undefined, undefined, "Unmatched")];
  it("finds the entries with the same volume and starting page", () => {
    expect(sieForLikkut(1, 4, list).map((x) => x.title)).toEqual(["Noach"]);
    expect(sieForLikkut(2, 4, list).map((x) => x.title)).toEqual(["Other"]);
  });
  it("also finds a translation that starts a page or two inside the sicha's own page range (before the next sicha begins)", () => {
    const l = [e(1, 217, "Tzav"), e(1, 219, "FourParshiyos"), e(1, 222, "Shemini")];
    expect(sieForLikkut(1, 217, l, 222).map((x) => x.title)).toEqual(["Tzav", "FourParshiyos"]); // 217 up to, not including, 222
    expect(sieForLikkut(1, 222, l, null).map((x) => x.title)).toEqual(["Shemini"]);
    expect(sieForLikkut(1, 222, l, 230).map((x) => x.title)).toEqual(["Shemini"]);
  });
  it("finds nothing for another page, a missing page, or an entry whose source is not known", () => {
    expect(sieForLikkut(1, 5, list)).toEqual([]);
    expect(sieForLikkut(1, null, list)).toEqual([]);
    expect(sieForLikkut(null, 1, list)).toEqual([]);
  });
  it("the real list only ever claims a real volume and page", () => {
    for (const x of SIE_WEEKLY) if (x.volume !== undefined) { expect(x.volume).toBeGreaterThan(0); expect(x.volume).toBeLessThanOrEqual(39); expect(x.page).toBeGreaterThan(0); }
  });
});

describe("sieContentRange (skip SIE's cover, blank page and dedication pages)", () => {
  const e = (from?: number, pageCount?: number) => ({ chelek: "Alef", sefer: "Bereishis", title: "T", url: "https://drive.google.com/file/d/xxxxxxxxxxxxxxxxxxxxxxxxx/view", from, pageCount });
  it("gives the page range that starts where the real content starts", () => {
    expect(sieContentRange(e(4, 18))).toBe("4-18");
    expect(sieContentRange(e(5, 30))).toBe("5-30");
  });
  it("gives nothing when the whole file should be used or the layout is unknown", () => {
    expect(sieContentRange(e(1, 18))).toBeUndefined();
    expect(sieContentRange(e(undefined, 18))).toBeUndefined();
    expect(sieContentRange(e(4, undefined))).toBeUndefined();
    expect(sieContentRange(e(19, 18))).toBeUndefined(); // never an empty range
  });
  it("the real list: every file starts at page 4 or 5 and has pages after it", () => {
    for (const x of SIE_WEEKLY) {
      expect([4, 5], x.title).toContain(x.from);
      expect(x.pageCount!, x.title).toBeGreaterThan(x.from!);
      expect(sieContentRange(x)).toMatch(/^[45]-\d+$/);
    }
  });
});
