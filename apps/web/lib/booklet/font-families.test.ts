import { describe, expect, it } from "vitest";
import { DAVID_LIBRE_BOLD_BASE64 } from "@/lib/booklet/fonts/david-libre-bold";
import { DAVID_LIBRE_REGULAR_BASE64 } from "@/lib/booklet/fonts/david-libre-regular";
import { EZRA_SIL_REGULAR_BASE64 } from "@/lib/booklet/fonts/ezra-sil-regular";
import { failure, fakeSupabase, ok } from "@/test/fake-supabase";
import { readFontFacts } from "./font-facts-read";
import { loadOrgFontFacts } from "./org-font-facts";
import { factsFromName, groupFamilies, nearestWeight, pickRoles, splitFontName, weightLabel } from "./font-families";
import { effective, englishFamilyChoices, englishRolePlan, familyOfFont, hebrewFamilyChoices, hebrewRolePlan, resolveFontIds, validOverrides, withFacts, type UploadedFont } from "./font-roles";

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const face = (id: string, family: string, weight: number) => ({ id, name: `${family} ${weightLabel(weight)}`, family, weight });

describe("a font's weight from its name", () => {
  it("reads the trailing weight words and leaves the family", () => {
    expect(splitFontName("OT Sid Daled Bold")).toEqual({ family: "OT Sid Daled", weight: 700 });
    expect(splitFontName("Vilna Light")).toEqual({ family: "Vilna", weight: 300 });
    expect(splitFontName("Inter-SemiBoldItalic")).toEqual({ family: "Inter", weight: 600 });
    expect(splitFontName("Frank Extra Light")).toEqual({ family: "Frank", weight: 200 });
    expect(splitFontName("Frank ExtraBold")).toEqual({ family: "Frank", weight: 800 });
    expect(splitFontName("Noto Serif Hebrew Black")).toEqual({ family: "Noto Serif Hebrew", weight: 900 });
    expect(splitFontName("Some Font Medium")).toEqual({ family: "Some Font", weight: 500 });
    expect(splitFontName("VilnaBold")).toEqual({ family: "Vilna", weight: 700 });
  });

  it("does not mistake part of a name for a weight, and a plain name is Regular", () => {
    expect(splitFontName("Marigold")).toEqual({ family: "Marigold", weight: null });
    expect(splitFontName("Bold")).toEqual({ family: "Bold", weight: null });
    expect(splitFontName("OT Talmudis")).toEqual({ family: "OT Talmudis", weight: null });
    expect(factsFromName("OT Talmudis")).toEqual({ family: "OT Talmudis", weight: 400 });
    expect(factsFromName("OT Siddur Regular")).toEqual({ family: "OT Siddur", weight: 400 });
  });
});

describe("a font's weight from the file itself", () => {
  it("reads OS/2 usWeightClass and the family from the bundled fonts", () => {
    expect(readFontFacts(bytes(DAVID_LIBRE_REGULAR_BASE64), "anything")).toEqual({ family: "David Libre", weight: 400 });
    expect(readFontFacts(bytes(DAVID_LIBRE_BOLD_BASE64), "anything")).toEqual({ family: "David Libre", weight: 700 });
    expect(readFontFacts(bytes(EZRA_SIL_REGULAR_BASE64), "x").weight).toBe(400);
  });

  it("falls back to the listed name for a file that cannot be read", () => {
    expect(readFontFacts(new Uint8Array([1, 2, 3, 4]), "OT Sid Daled Bold")).toEqual({ family: "OT Sid Daled", weight: 700 });
    expect(readFontFacts(new Uint8Array(), "Plain")).toEqual({ family: "Plain", weight: 400 });
  });
});

describe("loadOrgFontFacts: the uploaded files are read once, scoped to the organization", () => {
  it("reads each file's own weight, remembers it, and falls back to the name when a file cannot be fetched", async () => {
    const fake = fakeSupabase((call) => {
      if (call.table === "org_fonts") return ok([{ id: "f-bold", storage_path: "o1/bold.ttf" }, { id: "f-gone", storage_path: "o1/gone.ttf" }]);
      if (call.op === "download") return call.values === "o1/bold.ttf" ? ok(new Blob([bytes(DAVID_LIBRE_BOLD_BASE64)])) : failure("not found");
      return failure("unexpected");
    });
    const fonts = [{ id: "f-bold", name: "Mystery" }, { id: "f-gone", name: "Vilna Light" }, { id: "f-unlisted", name: "Other Bold" }];
    const first = await loadOrgFontFacts(fake.client as never, "o1", fonts);
    expect(first).toEqual({ "f-bold": { family: "David Libre", weight: 700 }, "f-gone": { family: "Vilna", weight: 300 }, "f-unlisted": { family: "Other", weight: 700 } });
    expect(fake.calls.find((c) => c.table === "org_fonts")!.filters).toContainEqual(["eq", "organization_id", "o1"]);
    const downloads = () => fake.calls.filter((c) => c.op === "download").map((c) => c.values);
    expect(downloads()).toEqual(["o1/bold.ttf", "o1/gone.ttf"]);
    // a second listing reads only the file that failed before
    expect(await loadOrgFontFacts(fake.client as never, "o1", fonts)).toEqual(first);
    expect(downloads()).toEqual(["o1/bold.ttf", "o1/gone.ttf", "o1/gone.ttf"]);
    expect(await loadOrgFontFacts(fake.client as never, "o1", [])).toEqual({});
  });
});

describe("families and the file for each job", () => {
  const sid = [face("r", "OT Sid", 400), face("b", "OT Sid", 700), face("l", "OT Sid", 300)];

  it("groups files by family, whatever the capitals and spacing, lightest first", () => {
    const groups = groupFamilies([...sid, { id: "t", name: "OT Talmudis", family: "OT Talmudis", weight: 400 }, { id: "x", name: "ot sid black", family: "ot  sid", weight: 900 }]);
    expect(groups.map((g) => g.name)).toEqual(["OT Sid", "OT Talmudis"]);
    expect(groups[0]!.faces.map((f) => f.id)).toEqual(["l", "r", "b", "x"]);
  });

  it("titles take the Bold, body and Rashi the Regular", () => {
    const roles = pickRoles(sid)!;
    expect([roles.title.id, roles.body.id, roles.rashi.id]).toEqual(["b", "r", "r"]);
  });

  it("a family of one weight uses it for everything", () => {
    const roles = pickRoles([face("only", "Solo", 400)])!;
    expect([roles.title.id, roles.body.id, roles.rashi.id]).toEqual(["only", "only", "only"]);
    expect(pickRoles([])).toBeNull();
  });

  it("a family with no bold takes its nearest weight for titles (never a faked bold)", () => {
    const noBold = pickRoles([face("l", "Thin Family", 300), face("r", "Thin Family", 400)])!;
    expect([noBold.title.id, noBold.body.id]).toEqual(["r", "r"]);
    const medium = pickRoles([face("r", "F", 400), face("m", "F", 500)])!;
    expect([medium.title.id, medium.body.id]).toEqual(["m", "r"]);
    const heavyOnly = pickRoles([face("sb", "F", 600), face("bl", "F", 900)])!;
    expect([heavyOnly.title.id, heavyOnly.body.id, heavyOnly.rashi.id]).toEqual(["sb", "sb", "sb"]);
    // of two equally near, the heavier
    expect(nearestWeight([face("a", "F", 300), face("b", "F", 500)], 400)!.id).toBe("b");
  });
});

describe("the form's font choices by job", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const D = "44444444-4444-4444-8444-444444444444";
  const E = "55555555-5555-4555-8555-555555555555";
  const up = (id: string, name: string, he: boolean, trop = true): UploadedFont => ({ id, name, hasHebrew: he, hasLatin: !he, hasCantillation: he && trop });
  const fonts = [up(A, "OT Sid", true), up(B, "OT Sid Bold", true), up(C, "OT Talmudis", true, false), up(D, "My Serif", false), up(E, "My Serif Bold", false)];
  // B's file says it belongs to "OT Sid" at 700; the rest are read from their names.
  const faces = withFacts(fonts, { [B]: { family: "OT Sid", weight: 700 } });
  const bundled = [
    { value: "david-libre", label: "David Libre (default)" },
    { value: "eb-garamond", label: "EB Garamond" },
  ];

  it("offers families, not files", () => {
    expect(hebrewFamilyChoices(faces).map((c) => c.label)).toEqual(["Printio's default (Ezra SIL)", "OT Sid - 2 weights", "OT Talmudis (no trop)"]);
    expect(englishFamilyChoices(bundled, faces).map((c) => c.label)).toEqual(["David Libre (default)", "EB Garamond", "My Serif - 2 weights"]);
    expect(familyOfFont(faces, B)).toBe("fam:otsid");
    expect(familyOfFont(faces, "gone")).toBeNull();
  });

  it("picks Bold for titles and Regular for body and Rashi, and sends only what differs from the body", () => {
    const hebrew = hebrewRolePlan(faces, "fam:otsid");
    expect([hebrew.auto.title.value, hebrew.auto.body.value, hebrew.auto.rashi.value]).toEqual([B, A, A]);
    const english = englishRolePlan(bundled, faces, "fam:myserif");
    expect(resolveFontIds({ language: "both", hebrew, english })).toEqual({ fontId: A, titleFontId: B, rashiFontId: null, latinFontId: D, latinTitleFontId: E, latinRashiFontId: null });
  });

  it("the defaults send nothing that is not needed: Printio's own Hebrew, a bundled English family with its own bold", () => {
    const hebrew = hebrewRolePlan(faces, "");
    const english = englishRolePlan(bundled, faces, "eb-garamond");
    expect(english.auto.title.value).toBe("eb-garamond:bold");
    expect(resolveFontIds({ language: "both", hebrew, english })).toEqual({ fontId: null, titleFontId: null, rashiFontId: null, latinFontId: "eb-garamond", latinTitleFontId: null, latinRashiFontId: null });
  });

  it("an override wins for its job: a display font for titles over Printio's own, regular titles in a bundled family", () => {
    const hebrew = hebrewRolePlan(faces, "");
    const english = englishRolePlan(bundled, faces, "eb-garamond");
    const ids = resolveFontIds({ language: "both", hebrew, hebrewOverrides: { title: C, rashi: A }, english, englishOverrides: { title: "eb-garamond", rashi: "eb-garamond:bold" } });
    expect(ids).toEqual({ fontId: null, titleFontId: C, rashiFontId: A, latinFontId: "eb-garamond", latinTitleFontId: "eb-garamond", latinRashiFontId: "eb-garamond:bold" });
    expect(effective(hebrew, { title: C }, "title").label).toBe("OT Talmudis");
  });

  it("leaves out the fonts of a language the booklet does not show, and drops overrides that are gone", () => {
    const hebrew = hebrewRolePlan(faces, "fam:otsid");
    const english = englishRolePlan(bundled, faces, "david-libre");
    expect(resolveFontIds({ language: "he", hebrew, english }).latinFontId).toBeNull();
    expect(resolveFontIds({ language: "en", hebrew, english })).toMatchObject({ fontId: null, titleFontId: null, rashiFontId: null, latinFontId: "david-libre" });
    expect(validOverrides(hebrew, { title: "gone", body: A })).toEqual({ body: A });
    // an unknown family falls back to Printio's own font
    expect(hebrewRolePlan(faces, "fam:nothing").auto.body.value).toBe("");
  });
});
