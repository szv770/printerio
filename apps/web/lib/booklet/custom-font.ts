import fontkit from "@pdf-lib/fontkit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Checks a Hebrew font an org admin uploads (SBL Hebrew, for example) before Printio stores it, and loads it back from the private
 * `org-fonts` bucket when a booklet is drawn. Pure bytes in, plain-language answer out: nothing here touches the network except
 * loadOrgFontBytes, which is handed a service-role client.
 */

export const MAX_FONT_BYTES = 8 * 1024 * 1024;
/** The most fonts one organization can keep. */
export const MAX_FONTS_PER_ORG = 12;
export const FONT_BUCKET = "org-fonts";

export type InspectFontResult =
  | { ok: true; name: string; hasHebrew: true; hasVowels: boolean; hasCantillation: boolean }
  | { ok: false; message: string };

const fail = (message: string): InspectFontResult => ({ ok: false, message });

const TTF_OR_OTF = "Please upload the font as a .ttf or .otf file.";

/** The 22 Hebrew base letters, alef to tav (final forms included). */
const HEBREW_LETTERS = range(0x05d0, 0x05ea);
/** Vowel points (niqqud) and the dagesh: U+05B0 to U+05BC, except U+05BA (holam haser for vav, rare: OT Heilig and OT Sid Hei lack it). */
const VOWEL_MARKS = range(0x05b0, 0x05bc).filter((cp) => cp !== 0x05ba);
/** Cantillation marks (taamim): U+0591 to U+05AF. A font that covers most of them counts. */
const CANTILLATION_MARKS = range(0x0591, 0x05af);
const CANTILLATION_SHARE = 0.8;

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const tag = (b: Uint8Array) => String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);

/** True when every table the font's directory lists lies inside the file (a cut-off download does not). */
function tablesFitInFile(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) return false;
  const numTables = view.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.length) return false;
  for (let i = 0; i < numTables; i++) {
    const entry = 12 + i * 16;
    const offset = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    if (offset + length > bytes.length) return false;
  }
  return true;
}

// Control characters, line/paragraph separators and bidi override marks (written as escapes so the source stays plain ASCII).
const STRIP_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");

/** A display name that is safe to show and store: no control characters, trimmed, 1-80 characters. */
export function sanitizeFontName(raw: string | null | undefined, fileName?: string): string {
  const clean = (s: string) =>
    s
      .replace(STRIP_CHARS, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .trim();
  const fromFont = clean(raw ?? "");
  if (fromFont) return fromFont;
  const fromFile = clean((fileName ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, ""));
  return fromFile || "Uploaded font";
}

/** What a font's coverage means for Hebrew text, from a "has this code point" test. Exported for tests. */
export function hebrewCoverage(has: (cp: number) => boolean): { hasHebrew: boolean; hasVowels: boolean; hasCantillation: boolean } {
  return {
    hasHebrew: HEBREW_LETTERS.every(has),
    hasVowels: VOWEL_MARKS.every(has),
    hasCantillation: CANTILLATION_MARKS.filter(has).length / CANTILLATION_MARKS.length >= CANTILLATION_SHARE,
  };
}

const PLAIN_SUBFAMILY = /^(regular|normal|book|roman|medium)$/i;

/**
 * The name shown in the font list. Several weights of one family (Regular, Bold) must not collide on the unique
 * (organization, name) pair, so a subfamily that is not plain Regular is added: "OT Sid Daled" + "Bold" = "OT Sid Daled Bold".
 */
export function fontDisplayName(
  font: { familyName?: string | null; subfamilyName?: string | null; fullName?: string | null },
  fileName?: string,
): string {
  const family = sanitizeFontName(font.familyName, "");
  const sub = sanitizeFontName(font.subfamilyName, "");
  const hasFamily = font.familyName != null && family !== "Uploaded font";
  if (hasFamily) {
    const hasSub = font.subfamilyName != null && sub !== "Uploaded font" && !PLAIN_SUBFAMILY.test(sub);
    if (!hasSub || family.toLowerCase().endsWith(sub.toLowerCase())) return family;
    return sanitizeFontName(`${family} ${sub}`);
  }
  return sanitizeFontName(font.fullName, fileName);
}

export function inspectFont(bytes: Uint8Array, fileName?: string): InspectFontResult {
  if (bytes.length === 0) return fail("That file is empty.");
  if (bytes.length > MAX_FONT_BYTES) return fail("That font file is bigger than 8 MB. Choose a smaller file.");
  if (bytes.length < 12) return fail(`This does not look like a font file. ${TTF_OR_OTF}`);

  const magic = tag(bytes);
  if (magic === "wOFF" || magic === "wOF2") {
    return fail(`This is a web font (WOFF). ${TTF_OR_OTF}`);
  }
  if (magic === "ttcf") {
    return fail("This file is a font collection (.ttc) that holds several fonts. Upload a single font as a .ttf or .otf file.");
  }
  const isTrueType = bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00;
  if (!isTrueType && magic !== "OTTO") {
    return fail(`This does not look like a font file. ${TTF_OR_OTF}`);
  }
  if (!tablesFitInFile(bytes)) {
    return fail("This font file is damaged or cut off. Download it again and try once more.");
  }

  let font: ReturnType<typeof fontkit.create>;
  try {
    font = fontkit.create(bytes as never);
  } catch {
    return fail("Printio could not read this font. It may be damaged. Try downloading it again, or use a different .ttf or .otf file.");
  }
  // fontkit.create returns a collection for .ttc files; the magic check above already refused those.
  if (!("hasGlyphForCodePoint" in font)) {
    return fail("This file is a font collection that holds several fonts. Upload a single font as a .ttf or .otf file.");
  }
  const single = font as unknown as {
    familyName?: string | null;
    subfamilyName?: string | null;
    fullName?: string | null;
    hasGlyphForCodePoint(codePoint: number): boolean;
  };

  let coverage: ReturnType<typeof hebrewCoverage>;
  let name: string;
  try {
    // Touch the character map once so a broken one fails here, not later while a booklet is drawn.
    single.hasGlyphForCodePoint(0x05d0);
    coverage = hebrewCoverage((cp) => single.hasGlyphForCodePoint(cp));
    name = fontDisplayName(
      { familyName: single.familyName, subfamilyName: single.subfamilyName, fullName: single.fullName },
      fileName,
    );
  } catch {
    return fail("Printio could not read this font. It may be damaged. Try downloading it again, or use a different .ttf or .otf file.");
  }

  if (!coverage.hasHebrew) {
    return fail("This font has no Hebrew letters. Choose a font that covers Hebrew, such as SBL Hebrew.");
  }
  return { ok: true, name, hasHebrew: true, hasVowels: coverage.hasVowels, hasCantillation: coverage.hasCantillation };
}

/**
 * The stored bytes of one of an organization's fonts, for drawing a booklet. `db` must be the service-role client (the bucket has
 * no policies for anyone else). Returns null when the font is missing, belongs to another organization, or cannot be downloaded.
 */
export async function loadOrgFontBytes(
  db: SupabaseClient<Database>,
  organizationId: string,
  fontId: string,
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const { data: row } = await db
    .from("org_fonts")
    .select("name, storage_path, organization_id")
    .eq("id", fontId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!row || row.organization_id !== organizationId || !row.storage_path) return null;

  const { data: blob, error } = await db.storage.from(FONT_BUCKET).download(row.storage_path);
  if (error || !blob) return null;
  return { name: row.name, bytes: new Uint8Array(await blob.arrayBuffer()) };
}
