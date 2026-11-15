import fontkit from "@pdf-lib/fontkit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { ENGLISH_FONT_CHOICES, loadBundledEnglishFont } from "@/lib/booklet/fonts/english";

/**
 * Checks a font an org admin uploads (a Hebrew font such as SBL Hebrew, or an English one) before Printio stores it, and loads it back from the private
 * `org-fonts` bucket when a booklet is drawn. Pure bytes in, plain-language answer out: nothing here touches the network except
 * loadOrgFontBytes, which is handed a service-role client.
 */

export const MAX_FONT_BYTES = 8 * 1024 * 1024;
/** The most fonts one organization can keep. */
export const MAX_FONTS_PER_ORG = 12;
export const FONT_BUCKET = "org-fonts";

export type InspectFontResult =
  | { ok: true; name: string; hasHebrew: boolean; hasLatin: boolean; hasVowels: boolean; hasCantillation: boolean }
  | { ok: false; message: string };

const fail = (message: string): InspectFontResult => ({ ok: false, message });

const TTF_OR_OTF = "Please upload the font as a .ttf or .otf file.";

/** The 22 Hebrew base letters, alef to tav (final forms included). */
const HEBREW_LETTERS = range(0x05d0, 0x05ea);
/** The English (Latin) letters: A-Z and a-z, all 52 must be there. */
const LATIN_LETTERS = [...range(0x41, 0x5a), ...range(0x61, 0x7a)];
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

/** True when a font has all 52 English letters (A-Z, a-z), from a "has this code point" test. Exported for tests. */
export function latinCoverage(has: (cp: number) => boolean): boolean {
  return LATIN_LETTERS.every(has);
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

/** Accept a font that covers Hebrew or English (or both); refuse one that covers neither. Exported for tests. */
export function judgeCoverage(
  name: string,
  coverage: { hasHebrew: boolean; hasVowels: boolean; hasCantillation: boolean },
  hasLatin: boolean,
): InspectFontResult {
  if (!coverage.hasHebrew && !hasLatin) return fail("This font has neither Hebrew nor English letters");
  // Vowel and cantillation marks only mean something for a font that covers Hebrew.
  return {
    ok: true,
    name,
    hasHebrew: coverage.hasHebrew,
    hasLatin,
    hasVowels: coverage.hasHebrew && coverage.hasVowels,
    hasCantillation: coverage.hasHebrew && coverage.hasCantillation,
  };
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
  let hasLatin: boolean;
  let name: string;
  try {
    // Touch the character map once so a broken one fails here, not later while a booklet is drawn.
    single.hasGlyphForCodePoint(0x05d0);
    coverage = hebrewCoverage((cp) => single.hasGlyphForCodePoint(cp));
    hasLatin = latinCoverage((cp) => single.hasGlyphForCodePoint(cp));
    name = fontDisplayName(
      { familyName: single.familyName, subfamilyName: single.subfamilyName, fullName: single.fullName },
      fileName,
    );
  } catch {
    return fail("Printio could not read this font. It may be damaged. Try downloading it again, or use a different .ttf or .otf file.");
  }

  return judgeCoverage(name, coverage, hasLatin);
}

/**
 * The stored bytes of one of an organization's fonts, for drawing a booklet. `db` must be the service-role client (the bucket has
 * no policies for anyone else). Returns null when the font is missing, belongs to another organization, or cannot be downloaded.
 */
export async function loadOrgFontBytes(
  db: SupabaseClient<Database>,
  organizationId: string,
  fontId: string,
): Promise<{ name: string; bytes: Uint8Array; hasHebrew: boolean; hasLatin: boolean } | null> {
  const { data: row } = await db
    .from("org_fonts")
    .select("name, storage_path, organization_id, has_hebrew, has_latin")
    .eq("id", fontId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!row || row.organization_id !== organizationId || !row.storage_path) return null;

  const { data: blob, error } = await db.storage.from(FONT_BUCKET).download(row.storage_path);
  if (error || !blob) return null;
  return {
    name: row.name,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    // Rows from before migration 0053 were all Hebrew fonts.
    hasHebrew: row.has_hebrew ?? true,
    hasLatin: row.has_latin ?? false,
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The three font choices of a form: an uploaded Hebrew font, an uploaded Hebrew title font, and an English font (bundled id or uploaded). */
export interface FontChoiceInput {
  fontId?: string | null;
  titleFontId?: string | null;
  latinFontId?: string | null;
}

/** Plain-language message when a choice is not a valid id, or null. Empty (null/undefined/"") means "the default". */
export function checkFontChoiceIds(input: FontChoiceInput): string | null {
  const { fontId, titleFontId, latinFontId } = input;
  if (fontId != null && (typeof fontId !== "string" || !UUID_RE.test(fontId))) return "Choose a font from the list.";
  if (titleFontId != null && (typeof titleFontId !== "string" || !UUID_RE.test(titleFontId))) return "Choose a title font from the list.";
  if (
    latinFontId != null &&
    (typeof latinFontId !== "string" || !(UUID_RE.test(latinFontId) || ENGLISH_FONT_CHOICES.some((c) => c.id === latinFontId)))
  ) {
    return "Choose an English font from the list.";
  }
  return null;
}

export type FontChoices =
  | {
      ok: true;
      /** The uploaded Hebrew body font; undefined means Printio's own. */
      hebrewFont?: Uint8Array;
      hebrewFontName: string;
      /** The uploaded Hebrew title font; undefined means titles use the body font. */
      titleFont?: Uint8Array;
      /** The chosen English font; undefined means the default (David Libre). */
      latinFont?: { regular: Uint8Array; bold?: Uint8Array };
    }
  | { ok: false; message: string };

/**
 * Loads the fonts a form chose, for the signed-in member's own organization only (loadOrgFontBytes scopes every read to it).
 * An uploaded font must cover what it is chosen for: Hebrew for the body and title fonts, English letters for the English font.
 * `db` must be the service-role client. Call checkFontChoiceIds first for the cheap shape check.
 */
export async function loadFontChoices(db: SupabaseClient<Database>, organizationId: string, input: FontChoiceInput): Promise<FontChoices> {
  const bad = checkFontChoiceIds(input);
  if (bad) return { ok: false, message: bad };
  const out: Extract<FontChoices, { ok: true }> = { ok: true, hebrewFontName: "" };

  if (input.fontId) {
    const font = await loadOrgFontBytes(db, organizationId, input.fontId);
    if (!font) return { ok: false, message: "That font is no longer available. Choose another one." };
    if (!font.hasHebrew) return { ok: false, message: `"${font.name}" has no Hebrew letters, so it cannot be the Hebrew font. Choose a Hebrew font.` };
    out.hebrewFont = font.bytes;
    out.hebrewFontName = font.name;
  }
  if (input.titleFontId) {
    const font = await loadOrgFontBytes(db, organizationId, input.titleFontId);
    if (!font) return { ok: false, message: "That title font is no longer available. Choose another one." };
    if (!font.hasHebrew) return { ok: false, message: `"${font.name}" has no Hebrew letters, so it cannot be the title font. Choose a Hebrew font.` };
    out.titleFont = font.bytes;
  }
  if (input.latinFontId) {
    if (UUID_RE.test(input.latinFontId)) {
      const font = await loadOrgFontBytes(db, organizationId, input.latinFontId);
      if (!font) return { ok: false, message: "That English font is no longer available. Choose another one." };
      if (!font.hasLatin) return { ok: false, message: `"${font.name}" has no English letters, so it cannot be the English font. Choose an English font.` };
      out.latinFont = { regular: font.bytes };
    } else {
      const bundled = await loadBundledEnglishFont(input.latinFontId);
      if (!bundled) return { ok: false, message: "That English font is not available. Choose another one." };
      out.latinFont = bundled;
    }
  }
  return out;
}
