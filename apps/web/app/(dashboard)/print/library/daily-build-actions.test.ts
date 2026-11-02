import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));

const dir = join(__dirname, "..", "..", "..", "..", "lib", "library", "daily", "fixtures");
const shiurHtml = readFileSync(join(dir, "shiur-2026-11-02.html"), "utf8");
const DATE = "2026-11-02";

const { parseShiurPage } = await import("@/lib/library/daily/source");
const fixtureRows = (studies?: string[]) =>
  (parseShiurPage(shiurHtml)?.studies ?? [])
    .filter((s) => !studies || studies.includes(s.study))
    .map((s) => ({ study: s.study, study_date: DATE, portion: s.portion, sections: s.sections }));

const state = vi.hoisted(() => ({ rows: [] as unknown[], upserts: [] as unknown[], rateOk: true }));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) chain[m] = () => chain;
    chain.upsert = async (rows: unknown) => {
      state.upserts.push(rows);
      return { error: null };
    };
    chain.then = (res: (v: unknown) => unknown) => res({ data: state.rows, error: null });
    return { rpc: async () => ({ data: state.rateOk, error: null }), from: () => chain };
  },
}));

import { buildDailyBookletAction, dailyDayAction } from "./daily-actions";

const member = (role = "org_admin", early = false) => ({ userId: "u1", membership: { organization_id: "o1", role, early_tools: early } });
const siteReturns = (body: string, status = 200) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })));

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.upserts = [];
  state.rateOk = true;
  requireSessionOrRedirect.mockResolvedValue(member());
  siteReturns(shiurHtml);
});

describe("dailyDayAction", () => {
  it("lists a day that is already saved without asking the site again", async () => {
    state.rows = fixtureRows(["tanya", "rambam1"]);
    const res = await dailyDayAction(DATE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items.map((i) => i.study)).toEqual(["tanya", "rambam1"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches an unsaved day from the site once, saves every study, and lists them", async () => {
    const res = await dailyDayAction(DATE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((i) => i.study)).toEqual(["chumash", "tanya", "hayomyom", "rambam3", "rambam1"]);
    expect(res.items.find((i) => i.study === "tanya")?.portion).toBe("Iggeret HaKodesh, middle of Epistle 29");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toMatch(/^https:\/\/chitas-site\.vercel\.app\/shiur\?from=2026-11-02&to=2026-11-02/);
    const saved = state.upserts.flat() as { study: string; study_date: string; source_url: string }[];
    expect(saved).toHaveLength(5);
    expect(saved.every((r) => r.study_date === DATE && r.source_url.startsWith("https://chitas-site.vercel.app/shiur"))).toBe(true);
  });

  it("says so when the source cannot be reached, and saves nothing", async () => {
    siteReturns("Server error", 500);
    const res = await dailyDayAction(DATE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/could not get/i);
    expect(state.upserts).toHaveLength(0);
  });

  it("refuses a page for a different day than the one asked for", async () => {
    const res = await dailyDayAction("2026-11-03");
    expect(res.ok).toBe(false);
    expect(state.upserts).toHaveLength(0);
  });

  it("does not save anything when the source's page looks different (no studies found)", async () => {
    siteReturns("<html><body>Maintenance</body></html>");
    const res = await dailyDayAction(DATE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/looks different/i);
    expect(state.upserts).toHaveLength(0);
  });

  it("needs the library to be open to the person, a good date, and respects the rate limit", async () => {
    requireSessionOrRedirect.mockResolvedValue(member("staff", false));
    expect((await dailyDayAction(DATE)).ok).toBe(false);
    requireSessionOrRedirect.mockResolvedValue(member());
    expect((await dailyDayAction("tomorrow")).ok).toBe(false);
    state.rateOk = false;
    expect((await dailyDayAction(DATE)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("buildDailyBookletAction", () => {
  it("builds a filled booklet from the saved text, in a multiple of four pages", async () => {
    state.rows = fixtureRows(["tanya", "rambam1"]);
    const res = await buildDailyBookletAction({ date: DATE, studies: ["rambam1", "tanya"], language: "both", sheet: "letter" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const doc = await PDFDocument.load(Buffer.from(res.pdfBase64, "base64"));
    expect(doc.getPageCount()).toBe(res.pages);
    expect(res.pages % 4).toBe(0);
    expect(doc.getPage(0).getSize()).toEqual({ width: 396, height: 612 });
    expect(res.fileName).toBe("Daily study 2026-11-02.pdf");
    expect(res.direction).toBe("ltr");
  });

  it("uses full Letter pages for the 11x17 sheet and binds Hebrew-only booklets on the right", async () => {
    state.rows = fixtureRows(["tanya"]);
    const res = await buildDailyBookletAction({ date: DATE, studies: ["tanya"], language: "he", sheet: "tabloid" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const doc = await PDFDocument.load(Buffer.from(res.pdfBase64, "base64"));
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(res.direction).toBe("rtl");
  });

  it("fetches the day first when it is not saved yet", async () => {
    // First read finds nothing; after the fetch the rows exist.
    const res = await buildDailyBookletAction({ date: DATE, studies: ["tanya"], language: "en", sheet: "letter" });
    expect(res.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.upserts.flat()).toHaveLength(5);
  });

  it("says when the source cannot give a study, instead of building a partial booklet", async () => {
    siteReturns("Server error", 500);
    const res = await buildDailyBookletAction({ date: DATE, studies: ["tanya", "chumash"], language: "both", sheet: "letter" });
    expect(res.ok).toBe(false);
  });

  it("refuses bad input and people without the library", async () => {
    state.rows = fixtureRows(["tanya"]);
    expect((await buildDailyBookletAction({ date: DATE, studies: [], language: "both", sheet: "letter" })).ok).toBe(false);
    expect((await buildDailyBookletAction({ date: DATE, studies: ["tanya"], language: "fr" as "he", sheet: "letter" })).ok).toBe(false);
    expect((await buildDailyBookletAction({ date: DATE, studies: ["tehillim" as "tanya"], language: "he", sheet: "letter" })).ok).toBe(false);
    requireSessionOrRedirect.mockResolvedValue(member("staff", false));
    expect((await buildDailyBookletAction({ date: DATE, studies: ["tanya"], language: "he", sheet: "letter" })).ok).toBe(false);
  });
});
