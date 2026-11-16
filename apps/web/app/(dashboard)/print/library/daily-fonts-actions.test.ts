import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failure, fakeSupabase, ok, type FakeCall } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));

const dir = join(__dirname, "..", "..", "..", "..", "..", "..", "packages", "shared", "src", "library", "daily", "fixtures");
const shiurHtml = readFileSync(join(dir, "shiur-2026-11-02.html"), "utf8");
const DATE = "2026-11-02";
const { parseShiurPage } = await import("@printio/shared/library/daily/source");
const rows = (parseShiurPage(shiurHtml)?.studies ?? []).map((s) => ({ study: s.study, study_date: DATE, portion: s.portion, sections: s.sections }));

// The renderer is covered by its own tests; here only what the action hands it matters.
const built = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[] }));
vi.mock("@/lib/library/daily/fill", () => ({
  buildFilledPdf: async (input: Record<string, unknown>) => {
    built.inputs.push(input);
    return { bytes: new Uint8Array([1, 2, 3]), pages: 4, fontSize: 9, missingMarks: { vowels: false, cantillation: false } };
  },
}));

const orgFonts = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), listed: [] as unknown[] }));
const dbCalls = vi.hoisted(() => ({ calls: [] as FakeCall[] }));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => {
    const fake = fakeSupabase((call) => {
      if (call.table === "check_rate_limit") return ok(true);
      if (call.table === "library_daily_texts") return ok(rows);
      if (call.table === "org_fonts") {
        const id = call.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2] as string;
        const org = call.filters.find((f) => f[0] === "eq" && f[1] === "organization_id")?.[2];
        const row = orgFonts.rows.get(id);
        return ok(row && row.organization_id === org ? row : null);
      }
      if (call.op === "download") return ok(new Blob([new Uint8Array([9, 9, 9])]));
      return failure("unexpected " + call.table);
    });
    return new Proxy(fake.client, {
      get: (t, k) => {
        dbCalls.calls = fake.calls;
        return (t as never)[k];
      },
    });
  },
}));
vi.mock("@/lib/booklet/org-fonts", () => ({ listOrgFonts: async () => orgFonts.listed }));

import { buildDailyBookletAction, dailyFontsAction } from "./daily-actions";

const HE_ID = "11111111-1111-4111-8111-111111111111";
const LATIN_ID = "22222222-2222-4222-8222-222222222222";
const BOTH_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_ID = "44444444-4444-4444-8444-444444444444";
const fontRow = (name: string, hasHebrew: boolean, hasLatin: boolean, org = "o1") => ({
  name,
  storage_path: `org/${org}/x.font`,
  organization_id: org,
  has_hebrew: hasHebrew,
  has_latin: hasLatin,
});
const base = { date: DATE, studies: ["chumash", "tanya", "rambam1"] as ("chumash" | "tanya" | "rambam1")[], language: "both" as const, sheet: "letter" as const };

beforeEach(() => {
  vi.clearAllMocks();
  built.inputs = [];
  dbCalls.calls = [];
  orgFonts.rows = new Map([
    [HE_ID, fontRow("OT Talmudis", true, false)],
    [LATIN_ID, fontRow("Some Serif", false, true)],
    [BOTH_ID, fontRow("Ezra-like", true, true)],
    [OTHER_ORG_ID, fontRow("Theirs", true, true, "o2")],
  ]);
  orgFonts.listed = [];
  requireSessionOrRedirect.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1", role: "org_admin", early_tools: false } });
});

describe("buildDailyBookletAction: Hebrew titles", () => {
  it("gives the renderer a Hebrew booklet title (the Hebrew date) and a Hebrew title per study, with the parsha only for the Chumash", async () => {
    const res = await buildDailyBookletAction(base);
    expect(res.ok).toBe(true);
    const input = built.inputs[0] as { titleHe: string; cover: { dateHe: string; dateEn: string }; items: { title: string; titleHe: string }[]; titleFont?: unknown; latinFont?: unknown };
    // The title is on the front page, with the date under it. 2026-11-02 is 22 Cheshvan 5787 (Rosh Chodesh Cheshvan was 2026-10-12).
    expect(input.titleHe).toBe("לימוד יומי");
    expect(input.cover.dateHe).toBe("יום שני, כ״ב חשון תשפ״ז");
    expect(input.cover.dateEn).toBe("Monday, November 2, 2026");
    expect(input.items.map((i) => i.titleHe)).toEqual(["חומש - פרשת חיי שרה", "תניא", "רמב״ם - פרק אחד"]);
    // The English titles are unchanged.
    expect(input.items[1]!.title).toMatch(/^Tanya - /);
    // No font chosen: the renderer falls back to its own defaults.
    expect(input.titleFont).toBeUndefined();
    expect(input.latinFont).toBeUndefined();
  });
});

describe("buildDailyBookletAction: font choices", () => {
  it("loads an uploaded Hebrew body font, title font and English font of the member's own organization", async () => {
    const res = await buildDailyBookletAction({ ...base, fontId: BOTH_ID, titleFontId: HE_ID, latinFontId: LATIN_ID });
    expect(res.ok).toBe(true);
    const input = built.inputs[0] as { hebrewFont: Uint8Array; titleFont: Uint8Array; latinFont: { regular: Uint8Array; bold?: Uint8Array } };
    expect([...input.hebrewFont]).toEqual([9, 9, 9]);
    expect([...input.titleFont]).toEqual([9, 9, 9]);
    expect([...input.latinFont.regular]).toEqual([9, 9, 9]);
    expect(input.latinFont.bold).toBeUndefined();
    // Every font read is scoped to the member's organization.
    for (const c of dbCalls.calls.filter((c) => c.table === "org_fonts")) expect(c.filters).toContainEqual(["eq", "organization_id", "o1"]);
  });

  it("uses a bundled English font by id", async () => {
    const res = await buildDailyBookletAction({ ...base, latinFontId: "david-libre" });
    expect(res.ok).toBe(true);
    const input = built.inputs[0] as { latinFont: { regular: Uint8Array; bold?: Uint8Array } };
    expect(input.latinFont.regular.length).toBeGreaterThan(1000);
    expect(input.latinFont.bold?.length).toBeGreaterThan(1000);
  });

  it("will not use a font from another organization, or one that is gone", async () => {
    for (const input of [{ fontId: OTHER_ORG_ID }, { titleFontId: OTHER_ORG_ID }, { latinFontId: OTHER_ORG_ID }, { fontId: "55555555-5555-4555-8555-555555555555" }]) {
      const res = await buildDailyBookletAction({ ...base, ...input });
      expect(res).toEqual({ ok: false, message: expect.stringMatching(/no longer available/) });
    }
    expect(built.inputs).toHaveLength(0);
  });

  it("checks what an uploaded font covers: Hebrew for the text and title fonts, English letters for the English font", async () => {
    const hebrewAsEnglish = await buildDailyBookletAction({ ...base, latinFontId: HE_ID });
    expect(hebrewAsEnglish).toEqual({ ok: false, message: expect.stringMatching(/"OT Talmudis" has no English letters/) });
    const englishAsBody = await buildDailyBookletAction({ ...base, fontId: LATIN_ID });
    expect(englishAsBody).toEqual({ ok: false, message: expect.stringMatching(/"Some Serif" has no Hebrew letters.*Hebrew font/) });
    const englishAsTitle = await buildDailyBookletAction({ ...base, titleFontId: LATIN_ID });
    expect(englishAsTitle).toEqual({ ok: false, message: expect.stringMatching(/"Some Serif" has no Hebrew letters.*title font/) });
    expect(built.inputs).toHaveLength(0);
  });

  it("refuses ids that are not UUIDs or bundled font ids, before touching the database", async () => {
    expect(await buildDailyBookletAction({ ...base, fontId: "nope" })).toEqual({ ok: false, message: "Choose a font from the list." });
    expect(await buildDailyBookletAction({ ...base, titleFontId: "david-libre" })).toEqual({ ok: false, message: "Choose a title font from the list." });
    expect(await buildDailyBookletAction({ ...base, latinFontId: "comic-sans" })).toEqual({ ok: false, message: "Choose an English font from the list." });
    expect((await buildDailyBookletAction({ ...base, latinFontId: 7 as unknown as string })).ok).toBe(false);
    expect(dbCalls.calls.filter((c) => c.table === "org_fonts")).toHaveLength(0);
  });
});

describe("buildDailyBookletAction: fonts by job", () => {
  type Roles = { hebrewFont?: Uint8Array; titleFont?: Uint8Array; rashiFont?: Uint8Array; latinFont?: { regular: Uint8Array; bold?: Uint8Array }; latinRashiFont?: Uint8Array };

  it("loads a Rashi font and English title and Rashi fonts, each scoped to the member's organization", async () => {
    const res = await buildDailyBookletAction({ ...base, fontId: BOTH_ID, titleFontId: HE_ID, rashiFontId: HE_ID, latinFontId: LATIN_ID, latinTitleFontId: BOTH_ID, latinRashiFontId: LATIN_ID });
    expect(res.ok).toBe(true);
    const input = built.inputs[0] as Roles;
    expect([...input.rashiFont!]).toEqual([9, 9, 9]);
    expect([...input.latinFont!.bold!]).toEqual([9, 9, 9]);
    expect([...input.latinRashiFont!]).toEqual([9, 9, 9]);
    for (const c of dbCalls.calls.filter((c) => c.table === "org_fonts")) expect(c.filters).toContainEqual(["eq", "organization_id", "o1"]);
  });

  it("a bundled family's files can be chosen by job: its regular for titles, its bold for Rashi", async () => {
    const res = await buildDailyBookletAction({ ...base, latinFontId: "eb-garamond", latinTitleFontId: "eb-garamond", latinRashiFontId: "eb-garamond:bold" });
    expect(res.ok).toBe(true);
    const input = built.inputs[0] as Roles;
    expect(input.latinFont!.bold).toEqual(input.latinFont!.regular);
    expect(input.latinRashiFont!.length).toBeGreaterThan(1000);
    expect(input.latinRashiFont).not.toEqual(input.latinFont!.regular);
    expect(input.rashiFont).toBeUndefined();
  });

  it("an English title font on top of the default English font keeps David Libre for the body", async () => {
    const res = await buildDailyBookletAction({ ...base, latinTitleFontId: LATIN_ID });
    expect(res.ok).toBe(true);
    const input = built.inputs[0] as Roles;
    expect(input.latinFont!.regular.length).toBeGreaterThan(1000);
    expect([...input.latinFont!.bold!]).toEqual([9, 9, 9]);
  });

  it("checks each job's font: own organization, the right letters, a real id", async () => {
    expect(await buildDailyBookletAction({ ...base, rashiFontId: OTHER_ORG_ID })).toEqual({ ok: false, message: expect.stringMatching(/Rashi font is no longer available/) });
    expect(await buildDailyBookletAction({ ...base, rashiFontId: LATIN_ID })).toEqual({ ok: false, message: expect.stringMatching(/"Some Serif" has no Hebrew letters.*Rashi font/) });
    expect(await buildDailyBookletAction({ ...base, latinTitleFontId: HE_ID })).toEqual({ ok: false, message: expect.stringMatching(/"OT Talmudis" has no English letters.*English title font/) });
    expect(await buildDailyBookletAction({ ...base, latinRashiFontId: OTHER_ORG_ID })).toEqual({ ok: false, message: expect.stringMatching(/no longer available/) });
    expect(built.inputs).toHaveLength(0);
    dbCalls.calls.length = 0;
    expect(await buildDailyBookletAction({ ...base, rashiFontId: "eb-garamond" })).toEqual({ ok: false, message: "Choose a Rashi font from the list." });
    expect(await buildDailyBookletAction({ ...base, latinTitleFontId: "eb-garamond:italic" })).toEqual({ ok: false, message: "Choose an English title font from the list." });
    expect(await buildDailyBookletAction({ ...base, latinRashiFontId: "comic-sans:bold" })).toEqual({ ok: false, message: "Choose an English Rashi font from the list." });
    expect(dbCalls.calls.filter((c) => c.table === "org_fonts")).toHaveLength(0);
  });
});

describe("dailyFontsAction", () => {
  it("says which family and weight each uploaded font is, so the form can group them (the name decides when the file cannot be read)", async () => {
    const SID_BOLD = "66666666-6666-4666-8666-666666666666";
    orgFonts.listed = [
      { id: BOTH_ID, name: "OT Sid Daled", hasVowels: true, hasCantillation: true, hasHebrew: true, hasLatin: false },
      { id: SID_BOLD, name: "OT Sid Daled Bold", hasVowels: true, hasCantillation: true, hasHebrew: true, hasLatin: false },
    ];
    const res = await dailyFontsAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.faces).toEqual({ [BOTH_ID]: { family: "OT Sid Daled", weight: 400 }, [SID_BOLD]: { family: "OT Sid Daled", weight: 700 } });
    // the font files are only read for the member's own organization
    for (const c of dbCalls.calls.filter((c) => c.table === "org_fonts")) expect(c.filters).toContainEqual(["eq", "organization_id", "o1"]);
  });

  it("returns the uploaded fonts with what they cover, and the bundled English fonts (David Libre first)", async () => {
    orgFonts.listed = [{ id: HE_ID, name: "OT Talmudis", hasVowels: true, hasCantillation: false, hasHebrew: true, hasLatin: false }];
    const res = await dailyFontsAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fonts).toEqual(orgFonts.listed);
    expect(res.englishFonts[0]).toEqual({ id: "david-libre", name: "David Libre (default)" });
    expect(res.englishFonts.length).toBeGreaterThan(1);
  });
});
