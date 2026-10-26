import { describe, expect, it } from "vitest";
import { SIE_CREDIT, SIE_WEEKLY } from "./sie-weekly";
import { groupSie } from "./sie";
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
