import { factsFromName, familyKey, groupFamilies, pickRoles, weightLabel, FONT_ROLES, type FontFacts, type FontRole } from "@/lib/booklet/font-families";

/**
 * The font choices of a booklet form, by job. The person picks a Hebrew family and an English family; Printio picks a file of the
 * family for the titles (its Bold), the body (its Regular) and Rashi (its Regular), and the form's "Fonts" section can override
 * each one. Pure, so the form and its tests share it. See font-families.ts for how files are grouped and weighed.
 *
 * Values: a Hebrew choice is an uploaded font's id, or "" for Printio's own Hebrew font. An English choice is an uploaded font's
 * id, a bundled family's id for its regular file ("eb-garamond"), or that id with ":bold" for its bold file.
 */

export interface UploadedFont {
  id: string;
  name: string;
  hasHebrew: boolean;
  hasLatin: boolean;
  hasCantillation: boolean;
}

export interface Face extends UploadedFont, FontFacts {}

export interface Choice {
  value: string;
  label: string;
}

export interface RolePlan {
  /** What Printio picks for each job when nothing is overridden. */
  auto: Record<FontRole, Choice>;
  /** What each job can be changed to: the family's own files first, then every other font that fits. */
  options: Record<FontRole, Choice[]>;
}

export const ROLE_NAMES: Record<FontRole, string> = { title: "Titles", body: "Body text", rashi: "Rashi" };
export const DEFAULT_HEBREW_NAME = "Ezra SIL";
const FAMILY_PREFIX = "fam:";

/** Each uploaded font with its family and weight (from the server's reading of the file, else from its name). */
export function withFacts(fonts: readonly UploadedFont[], facts: Record<string, FontFacts> | undefined): Face[] {
  return fonts.map((f) => ({ ...f, ...(facts?.[f.id] ?? factsFromName(f.name)) }));
}

const familiesOf = (faces: readonly Face[], script: "hasHebrew" | "hasLatin") => groupFamilies(faces.filter((f) => f[script]));

/** The Hebrew families to offer: Printio's own first (value ""), then each uploaded family with Hebrew letters. */
export function hebrewFamilyChoices(faces: readonly Face[]): Choice[] {
  return [
    { value: "", label: `Printio's default (${DEFAULT_HEBREW_NAME})` },
    ...familiesOf(faces, "hasHebrew").map((fam) => {
      const body = pickRoles(fam.faces)!.body;
      const weights = fam.faces.length > 1 ? ` - ${fam.faces.length} weights` : "";
      return { value: FAMILY_PREFIX + fam.key, label: `${fam.name}${weights}${body.hasCantillation ? "" : " (no trop)"}` };
    }),
  ];
}

/** The English families to offer: the bundled ones first (their ids), then each uploaded family with English letters. */
export function englishFamilyChoices(bundled: readonly Choice[], faces: readonly Face[]): Choice[] {
  return [
    ...bundled,
    ...familiesOf(faces, "hasLatin").map((fam) => ({ value: FAMILY_PREFIX + fam.key, label: fam.faces.length > 1 ? `${fam.name} - ${fam.faces.length} weights` : fam.name })),
  ];
}

/** The family value that holds a font id (how a choice remembered from before families existed is found again), or null. */
export function familyOfFont(faces: readonly Face[], fontId: string): string | null {
  const face = faces.find((f) => f.id === fontId);
  return face ? FAMILY_PREFIX + (familyKey(face.family) || familyKey(face.name) || face.id) : null;
}

const faceChoice = (f: Face): Choice => ({ value: f.id, label: f.name });
const uniq = (choices: Choice[]): Choice[] => choices.filter((c, i) => choices.findIndex((o) => o.value === c.value) === i);

function uploadedPlan(faces: readonly Face[], family: string, script: "hasHebrew" | "hasLatin"): RolePlan | null {
  const fam = familiesOf(faces, script).find((f) => FAMILY_PREFIX + f.key === family);
  const picked = fam && pickRoles(fam.faces);
  if (!fam || !picked) return null;
  const all = uniq([...fam.faces.map(faceChoice), ...faces.filter((f) => f[script]).map(faceChoice)]);
  const auto = (role: FontRole): Choice => ({ value: picked[role].id, label: fam.faces.length > 1 ? `${weightLabel(picked[role].weight)} (${picked[role].name})` : picked[role].name });
  return { auto: { title: auto("title"), body: auto("body"), rashi: auto("rashi") }, options: { title: all, body: all, rashi: all } };
}

/** The Hebrew plan for a family value ("" is Printio's own font, which has one weight). An unknown family falls back to Printio's own. */
export function hebrewRolePlan(faces: readonly Face[], family: string): RolePlan {
  const plan = family ? uploadedPlan(faces, family, "hasHebrew") : null;
  if (plan) return plan;
  const own: Choice = { value: "", label: DEFAULT_HEBREW_NAME };
  const others = faces.filter((f) => f.hasHebrew).map(faceChoice);
  return { auto: { title: own, body: own, rashi: own }, options: { title: others, body: others, rashi: others } };
}

/** The English plan for a family value: a bundled family (regular for body and Rashi, bold for titles) or an uploaded one. */
export function englishRolePlan(bundled: readonly Choice[], faces: readonly Face[], family: string): RolePlan {
  const plan = uploadedPlan(faces, family, "hasLatin");
  if (plan) return plan;
  const fam = bundled.find((b) => b.value === family) ?? bundled[0] ?? { value: "david-libre", label: "David Libre" };
  const name = fam.label.replace(/\s*\(default\)$/i, "");
  const regular: Choice = { value: fam.value, label: `Regular (${name})` };
  const bold: Choice = { value: `${fam.value}:bold`, label: `Bold (${name})` };
  const others = faces.filter((f) => f.hasLatin).map(faceChoice);
  return { auto: { title: bold, body: regular, rashi: regular }, options: { title: [bold, regular, ...others], body: [regular, ...others], rashi: [regular, bold, ...others] } };
}

export type RoleOverrides = Partial<Record<FontRole, string>>;

/** The choice in effect for a job: the override when it is still one of the options, else the automatic pick. */
export function effective(plan: RolePlan, overrides: RoleOverrides | undefined, role: FontRole): Choice {
  const over = overrides?.[role];
  return (over ? plan.options[role].find((c) => c.value === over) : undefined) ?? plan.auto[role];
}

/** Drops overrides that are no longer among a plan's options (a font was removed, or the family changed). */
export function validOverrides(plan: RolePlan, overrides: RoleOverrides | undefined): RoleOverrides {
  const out: RoleOverrides = {};
  for (const role of FONT_ROLES) {
    const v = overrides?.[role];
    if (v && plan.options[role].some((c) => c.value === v)) out[role] = v;
  }
  return out;
}

export interface FontIds {
  fontId: string | null;
  titleFontId: string | null;
  rashiFontId: string | null;
  latinFontId: string | null;
  latinTitleFontId: string | null;
  latinRashiFontId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the booklet builder is sent. A job that uses the same file as the body is left out (null), so no file is loaded twice;
 * fonts of a language the booklet does not show are left out too, so a stale choice cannot fail a build.
 */
export function resolveFontIds(input: {
  language: "he" | "en" | "both";
  hebrew: RolePlan;
  hebrewOverrides?: RoleOverrides;
  english: RolePlan;
  englishOverrides?: RoleOverrides;
}): FontIds {
  const out: FontIds = { fontId: null, titleFontId: null, rashiFontId: null, latinFontId: null, latinTitleFontId: null, latinRashiFontId: null };
  if (input.language !== "en") {
    const pick = (role: FontRole) => effective(input.hebrew, input.hebrewOverrides, role).value;
    const body = pick("body");
    out.fontId = body || null;
    out.titleFontId = pick("title") && pick("title") !== body ? pick("title") : null;
    out.rashiFontId = pick("rashi") && pick("rashi") !== body ? pick("rashi") : null;
  }
  if (input.language !== "he") {
    const pick = (role: FontRole) => effective(input.english, input.englishOverrides, role).value;
    const body = pick("body");
    const title = pick("title");
    const rashi = pick("rashi");
    out.latinFontId = body || null;
    // A bundled family brings its own bold for titles; an uploaded body font is its own bold unless another file is chosen.
    const defaultTitle = UUID.test(body) ? body : `${body}:bold`;
    out.latinTitleFontId = title && title !== defaultTitle ? title : null;
    out.latinRashiFontId = rashi && rashi !== body ? rashi : null;
  }
  return out;
}
