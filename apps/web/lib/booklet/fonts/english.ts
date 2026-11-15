/**
 * The English (Latin) fonts bundled with Printio, for booklets whose English text should not be David Libre.
 * Every family has a regular and a bold face. Each family is its own module (lib/booklet/fonts/english/<family>.ts, about 100 KB of
 * base64), loaded only when it is chosen, so picking one never pulls the others into memory. Licences: english/LICENSES.txt.
 */

export const DEFAULT_ENGLISH_FONT_ID = "david-libre";

export const ENGLISH_FONT_CHOICES: { id: string; name: string }[] = [
  { id: DEFAULT_ENGLISH_FONT_ID, name: "David Libre (default)" },
  { id: "eb-garamond", name: "EB Garamond" },
  { id: "source-serif-4", name: "Source Serif 4" },
  { id: "libre-baskerville", name: "Libre Baskerville" },
];

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

/** The regular and bold font files of a bundled family, or null for an id that is not one. Only the chosen family is loaded. */
export async function loadBundledEnglishFont(id: string): Promise<{ regular: Uint8Array; bold: Uint8Array } | null> {
  switch (id) {
    case "david-libre": {
      const [r, b] = await Promise.all([import("./david-libre-regular"), import("./david-libre-bold")]);
      return { regular: bytes(r.DAVID_LIBRE_REGULAR_BASE64), bold: bytes(b.DAVID_LIBRE_BOLD_BASE64) };
    }
    case "eb-garamond": {
      const m = await import("./english/eb-garamond");
      return { regular: bytes(m.EB_GARAMOND_REGULAR_BASE64), bold: bytes(m.EB_GARAMOND_BOLD_BASE64) };
    }
    case "source-serif-4": {
      const m = await import("./english/source-serif-4");
      return { regular: bytes(m.SOURCE_SERIF_4_REGULAR_BASE64), bold: bytes(m.SOURCE_SERIF_4_BOLD_BASE64) };
    }
    case "libre-baskerville": {
      const m = await import("./english/libre-baskerville");
      return { regular: bytes(m.LIBRE_BASKERVILLE_REGULAR_BASE64), bold: bytes(m.LIBRE_BASKERVILLE_BOLD_BASE64) };
    }
    default:
      return null;
  }
}
