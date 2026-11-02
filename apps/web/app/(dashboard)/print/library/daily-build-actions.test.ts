import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));

const dir = join(__dirname, "..", "..", "..", "..", "lib", "library", "daily", "fixtures");
const read = (n: string) => readFileSync(join(dir, n), "utf8");
const feedXml = read("dailystudy-rss-2026-11-01.xml");

const { parseStudyPage } = await import("@/lib/library/daily/page");
const savedRows = (studies: string[]) =>
  studies.map((study) => {
    const file = { chumash: "study-chumash.html", tanya: "study-tanya.html", rambam1: "study-rambam1.html", rambam3: "study-rambam3.html" }[study]!;
    const page = parseStudyPage(read(file), study as "tanya");
    return { study, study_date: "2026-11-01", portion: page.portion, sections: page.sections };
  });
const state = vi.hoisted(() => ({ rows: [] as unknown[], rateOk: true }));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => res({ data: state.rows, error: null });
    return { rpc: async () => ({ data: state.rateOk, error: null }), from: () => chain };
  },
}));

import { buildDailyBookletAction, dailyDayAction } from "./daily-actions";

const member = (role = "org_admin", early = false) => ({ userId: "u1", membership: { organization_id: "o1", role, early_tools: early } });

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.rateOk = true;
  requireSessionOrRedirect.mockResolvedValue(member());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(feedXml, { status: 200, headers: { "content-type": "text/xml" } })));
});

describe("dailyDayAction", () => {
  it("lists the four studies for the day with the portion and whether the text is saved", async () => {
    state.rows = [{ study: "tanya" }];
    const res = await dailyDayAction("2026-11-01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((i) => i.study)).toEqual(["chumash", "tanya", "rambam1", "rambam3"]);
    expect(res.items.find((i) => i.study === "tanya")).toMatchObject({ saved: true, portion: "Iggeret HaKodesh, middle of Epistle 29" });
    expect(res.items.find((i) => i.study === "chumash")?.saved).toBe(false);
    expect(res.items.find((i) => i.study === "rambam1")?.url).toBe("https://www.chabad.org/dailystudy/rambam.asp?tdate=11/1/2026&rambamChapters=1");
  });
  it("still shows what is saved when Chabad.org's list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    state.rows = [{ study: "tanya", portion: "Saved portion" }];
    const res = await dailyDayAction("2026-11-01");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items).toEqual([{ study: "tanya", label: "Tanya", portion: "Saved portion", saved: true }]);
  });
  it("needs the library to be open to the person", async () => {
    requireSessionOrRedirect.mockResolvedValue(member("staff", false));
    expect((await dailyDayAction("2026-11-01")).ok).toBe(false);
  });
  it("refuses a bad date", async () => {
    expect((await dailyDayAction("tomorrow")).ok).toBe(false);
  });
});

describe("buildDailyBookletAction", () => {
  it("builds a filled booklet from the saved text, in a multiple of four pages", async () => {
    state.rows = savedRows(["tanya", "rambam1"]);
    const res = await buildDailyBookletAction({ date: "2026-11-01", studies: ["rambam1", "tanya"], language: "both", sheet: "letter" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const doc = await PDFDocument.load(Buffer.from(res.pdfBase64, "base64"));
    expect(doc.getPageCount()).toBe(res.pages);
    expect(res.pages % 4).toBe(0);
    expect(doc.getPage(0).getSize()).toEqual({ width: 396, height: 612 });
    expect(res.fileName).toBe("Daily study 2026-11-01.pdf");
    expect(res.direction).toBe("ltr");
  });
  it("uses full Letter pages for the 11x17 sheet and binds Hebrew-only booklets on the right", async () => {
    state.rows = savedRows(["tanya"]);
    const res = await buildDailyBookletAction({ date: "2026-11-01", studies: ["tanya"], language: "he", sheet: "tabloid" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const doc = await PDFDocument.load(Buffer.from(res.pdfBase64, "base64"));
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(res.direction).toBe("rtl");
  });
  it("says which study is not saved yet instead of building a partial booklet", async () => {
    state.rows = savedRows(["tanya"]);
    const res = await buildDailyBookletAction({ date: "2026-11-01", studies: ["tanya", "chumash"], language: "both", sheet: "letter" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/Chumash with Rashi/);
  });
  it("refuses bad input and people without the library", async () => {
    state.rows = savedRows(["tanya"]);
    expect((await buildDailyBookletAction({ date: "2026-11-01", studies: [], language: "both", sheet: "letter" })).ok).toBe(false);
    expect((await buildDailyBookletAction({ date: "2026-11-01", studies: ["tanya"], language: "fr" as "he", sheet: "letter" })).ok).toBe(false);
    expect((await buildDailyBookletAction({ date: "2026-11-01", studies: ["hayomyom" as "tanya"], language: "he", sheet: "letter" })).ok).toBe(false);
    requireSessionOrRedirect.mockResolvedValue(member("staff", false));
    expect((await buildDailyBookletAction({ date: "2026-11-01", studies: ["tanya"], language: "he", sheet: "letter" })).ok).toBe(false);
  });
});
