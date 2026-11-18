/**
 * Font families and weights. A family usually comes as several files (Regular, Bold, Light, ...), and each uploaded file is its
 * own entry in Admin -> Fonts. Here the files are grouped into families, each file's weight is found, and a file is picked for
 * each job in a booklet: titles and headings take the family's Bold (the weight nearest 700), the body text its Regular (nearest
 * 400), and Rashi the Regular too (it is already set smaller). A family with one file uses that file for everything: a bold is
 * never faked.
 *
 * The weight comes from the font file itself (its OS/2 usWeightClass), read when the list of fonts is made, so nothing about
 * weights is stored in the database. When a file cannot be read, or says "400" while its own style name says otherwise (a common
 * slip in font tools), the style name decides ("OT Sid Daled Bold" is 700).
 * Pure: no network, no database, and no font library (the form uses this in the browser; reading a file is in font-facts-read.ts).
 */

export type FontRole = "title" | "body" | "rashi";
export const FONT_ROLES: readonly FontRole[] = ["title", "body", "rashi"];

/** The weight each job asks for; the nearest file of the family is used. */
export const ROLE_WEIGHT: Record<FontRole, number> = { title: 700, body: 400, rashi: 400 };

const WEIGHT_WORDS: [RegExp, number][] = [
  [/(hairline|thin)/, 100],
  [/(extra|ultra)[\s-]?light/, 200],
  [/(semi|demi)[\s-]?light/, 350],
  [/light/, 300],
  [/(extra|ultra)[\s-]?bold/, 800],
  [/(semi|demi)[\s-]?bold/, 600],
  [/(black|heavy)/, 900],
  [/bold/, 700],
  [/medium/, 500],
  [/(regular|normal|book|roman)/, 400],
];

/** The last word of a font name when it is a weight or a slant ("Bold", "SemiBold", "Extra Light", "Italic"). */
const TAIL = /[\s\-_]*(?:(?:extra|ultra|semi|demi)[\s-]?(?:light|bold)|hairline|thin|light|regular|normal|book|roman|medium|bold|black|heavy|italic|oblique)$/i;

/**
 * Splits a font's name into its family and the weight its last words name: "OT Sid Daled Bold" is family "OT Sid Daled", 700;
 * "Inter-SemiBoldItalic" is "Inter", 600; "Marigold" stays whole (no weight: null). Only trailing words count, and a word glued to
 * the name counts only at a capital letter ("VilnaBold", not "Marigold").
 */
export function splitFontName(name: string): { family: string; weight: number | null } {
  let family = name.trim();
  let tail = "";
  for (;;) {
    const m = TAIL.exec(family);
    if (!m || m.index === 0) break;
    const glued = !/^[\s\-_]/.test(m[0]);
    if (glued && !(/[a-z]/.test(family[m.index - 1]!) && /[A-Z]/.test(family[m.index]!))) break;
    tail = `${m[0]} ${tail}`;
    family = family.slice(0, m.index).trim();
  }
  const words = tail.toLowerCase();
  const hit = WEIGHT_WORDS.find(([re]) => re.test(words));
  return { family, weight: hit ? hit[1] : null };
}

export interface FontFacts {
  /** The family the file belongs to ("OT Sid Daled"). */
  family: string;
  /** 100 (thin) to 900 (black); 400 is regular, 700 bold. */
  weight: number;
}

/** Family and weight from a stored display name alone (used when the file itself cannot be read). */
export function factsFromName(name: string): FontFacts {
  const { family, weight } = splitFontName(name);
  return { family: family || name.trim(), weight: weight ?? 400 };
}

const WEIGHT_LABELS: [number, string][] = [
  [100, "Thin"],
  [200, "Extra Light"],
  [300, "Light"],
  [350, "Semi Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semi Bold"],
  [700, "Bold"],
  [800, "Extra Bold"],
  [900, "Black"],
];

/** "Bold" for 700, "Regular" for 400, the nearest name for anything between. */
export function weightLabel(weight: number): string {
  return WEIGHT_LABELS.reduce((best, cur) => (Math.abs(cur[0] - weight) < Math.abs(best[0] - weight) ? cur : best))[1];
}

export interface FamilyFace {
  id: string;
  /** The name the file is listed under. */
  name: string;
  weight: number;
}

export interface FontFamily<F extends FamilyFace = FamilyFace> {
  /** Stable for a family name, whatever its capitals and spacing. */
  key: string;
  name: string;
  /** Lightest first. */
  faces: F[];
}

export const familyKey = (family: string): string => family.toLowerCase().replace(/[^a-z0-9֐-׿]+/g, "");

/** Groups font files into families (by family name, ignoring capitals and spacing), in the order the families first appear. */
export function groupFamilies<F extends FamilyFace & { family: string }>(faces: readonly F[]): FontFamily<F>[] {
  const out = new Map<string, FontFamily<F>>();
  for (const face of faces) {
    const key = familyKey(face.family) || familyKey(face.name) || face.id;
    const fam = out.get(key);
    if (fam) fam.faces.push(face);
    else out.set(key, { key, name: face.family || face.name, faces: [face] });
  }
  for (const fam of out.values()) fam.faces.sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name));
  return [...out.values()];
}

/** The face whose weight is nearest `target`; of two equally near, the heavier (as browsers do for 400). */
export function nearestWeight<F extends FamilyFace>(faces: readonly F[], target: number): F | undefined {
  let best: F | undefined;
  for (const f of faces) {
    if (!best) best = f;
    else {
      const d = Math.abs(f.weight - target) - Math.abs(best.weight - target);
      if (d < 0 || (d === 0 && f.weight > best.weight)) best = f;
    }
  }
  return best;
}

/**
 * The file a family uses for each job: titles the weight nearest 700, body and Rashi the weight nearest 400. A family with no
 * bold gives its nearest (often the same file as the body); a family of one file gives that file three times.
 */
export function pickRoles<F extends FamilyFace>(faces: readonly F[]): Record<FontRole, F> | null {
  if (faces.length === 0) return null;
  return {
    title: nearestWeight(faces, ROLE_WEIGHT.title)!,
    body: nearestWeight(faces, ROLE_WEIGHT.body)!,
    rashi: nearestWeight(faces, ROLE_WEIGHT.rashi)!,
  };
}
