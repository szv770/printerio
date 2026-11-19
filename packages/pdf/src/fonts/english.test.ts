import { describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import { ENGLISH_FONT_CHOICES, loadBundledEnglishFont } from "./english";

const LATIN = "The quick brown fox, 0123456789 (“quoted”) — it’s Ünïcode: …";

describe("bundled English fonts", () => {
  it("lists David Libre first as the default, then the other families, with unique ids", () => {
    expect(ENGLISH_FONT_CHOICES[0]).toEqual({ id: "david-libre", name: "David Libre (default)" });
    expect(ENGLISH_FONT_CHOICES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ENGLISH_FONT_CHOICES.map((c) => c.id)).size).toBe(ENGLISH_FONT_CHOICES.length);
  });

  it("has a static regular and bold face with every English letter for each choice", async () => {
    for (const c of ENGLISH_FONT_CHOICES) {
      const f = await loadBundledEnglishFont(c.id);
      expect(f, c.id).not.toBeNull();
      const regular = fontkit.create(Buffer.from(f!.regular)) as unknown as { hasGlyphForCodePoint(cp: number): boolean; variationAxes: object; "OS/2": { usWeightClass: number } };
      const bold = fontkit.create(Buffer.from(f!.bold)) as unknown as typeof regular;
      for (const font of [regular, bold]) {
        expect(Object.keys(font.variationAxes ?? {}), `${c.id} must be static`).toHaveLength(0);
        for (const ch of LATIN) expect(font.hasGlyphForCodePoint(ch.codePointAt(0)!), `${c.id} ${ch}`).toBe(true);
      }
      expect(bold["OS/2"].usWeightClass, c.id).toBeGreaterThan(regular["OS/2"].usWeightClass);
    }
  });

  it("returns null for an id that is not bundled", async () => {
    expect(await loadBundledEnglishFont("comic-sans")).toBeNull();
    expect(await loadBundledEnglishFont("")).toBeNull();
  });

  it("keeps each family under 400 KB of base64", async () => {
    for (const c of ENGLISH_FONT_CHOICES) {
      const f = (await loadBundledEnglishFont(c.id))!;
      expect(Math.ceil(((f.regular.length + f.bold.length) * 4) / 3), c.id).toBeLessThan(400_000);
    }
  });
});
