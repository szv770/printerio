import fontkit from "@pdf-lib/fontkit";
import { factsFromName, splitFontName, type FontFacts } from "@/lib/booklet/font-families";

/**
 * Family and weight of a font file, from the file itself: the weight from OS/2 usWeightClass, the family from the name table
 * (the "typographic family" when the font has one, else its family name without weight words). `displayName` is the name the
 * font is listed under; it is the fallback for anything the file does not say, and for a file that cannot be read.
 * A file that says plain 400 while its own style name says Bold or Light (a common slip in font tools) is believed by its name.
 */
export function readFontFacts(bytes: Uint8Array, displayName: string): FontFacts {
  const byName = factsFromName(displayName);
  try {
    const font = fontkit.create(bytes as never) as unknown as {
      familyName?: string | null;
      subfamilyName?: string | null;
      getName?: (key: string) => string | null | undefined;
      "OS/2"?: { usWeightClass?: number };
    };
    const name = (key: string) => {
      try {
        return font.getName?.(key)?.trim() || null;
      } catch {
        return null;
      }
    };
    const sub = name("preferredSubfamily") ?? font.subfamilyName ?? "";
    const named = splitFontName(`x ${sub}`).weight ?? splitFontName(font.familyName ?? "").weight ?? splitFontName(displayName).weight;
    const os2 = font["OS/2"]?.usWeightClass;
    const os2Ok = typeof os2 === "number" && os2 >= 1 && os2 <= 1000;
    const weight = os2Ok && !(os2 === 400 && named && named !== 400) ? os2 : named ?? byName.weight;
    const family = name("preferredFamily") ?? (splitFontName(font.familyName ?? "").family || byName.family);
    return { family: family.replace(/\s+/g, " ").slice(0, 80) || byName.family, weight };
  } catch {
    return byName;
  }
}
