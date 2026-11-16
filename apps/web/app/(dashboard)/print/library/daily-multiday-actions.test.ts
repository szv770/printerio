import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "@/test/memory-db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => dbBox.client }));
const live = vi.hoisted(() => ({ fetchShiurDay: vi.fn() }));
vi.mock("@/lib/library/daily/source-fetch", () => ({ fetchShiurDay: live.fetchShiurDay }));
// The renderer is covered by its own tests; here only what the action hands it matters.
const built = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[] }));
vi.mock("@/lib/library/daily/fill", () => ({
  buildFilledPdf: async (input: Record<string, unknown>) => {
    built.inputs.push(input);
    return { bytes: new Uint8Array([1, 2, 3]), pages: 8, fontSize: 11, missingMarks: { vowels: false, cantillation: false } };
  },
}));

import { buildDailyBookletAction } from "./daily-actions";
import { shiurUrl } from "@printio/shared/library/daily/source";
import { shiftIso } from "@printio/shared/library/daily/dates";
import { longDate } from "@/lib/library/daily/studies";

const D1 = new Date().toISOString().slice(0, 10);
const D2 = shiftIso(D1, 1);
const D3 = shiftIso(D1, 2);
const sections = (mark: string) => [{ heading: "", blocks: [{ kind: "verse", num: "1", he: `א ${mark}`, en: `a ${mark}` }] }];
const saved = (date: string, study: string): Row => ({ study, study_date: date, portion: `${study} of ${date}`, sections: sections(`${study}-${date}`), source_url: shiurUrl(date) });
const fetched = (date: string, studies: string[]) => ({ ok: true, url: shiurUrl(date), day: { date, studies: studies.map((s) => ({ study: s, portion: `${s} of ${date}`, sections: sections(`${s}-${date}`) })) } });
const onlineFetcher = (): Record<string, Row[]> => ({ library_fetchers: [{ agent_id: "a1" }], agents: [{ id: "a1", status: "active", last_seen_at: new Date(Date.now() - 30_000).toISOString() }] });

let mem: ReturnType<typeof memoryDb>;
function setup(tables: Record<string, Row[]> = {}) {
  mem = memoryDb({ library_daily_texts: [], library_fetchers: [], agents: [], ...tables });
  dbBox.client = mem.client;
}
const was = process.env.LIBRARY_VIA_SERVER;
const switchTo = (v: string | undefined) => (v === undefined ? delete process.env.LIBRARY_VIA_SERVER : (process.env.LIBRARY_VIA_SERVER = v));
const base = { date: D1, studies: ["chumash", "tanya"] as ("chumash" | "tanya")[], language: "both" as const, sheet: "letter" as const };
type Input = { items: { title: string; groupTitle?: string; sections: { blocks: { he: string }[] }[] }[]; cover: { dateEn: string; contents: { label: string; text: string }[] }; columns: string; title: string };
const input = () => built.inputs[0] as unknown as Input;

beforeEach(() => {
  vi.clearAllMocks();
  built.inputs = [];
  requireSessionOrRedirect.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1", role: "org_admin", early_tools: false } });
  live.fetchShiurDay.mockResolvedValue({ ok: false, reason: "unreachable" });
  switchTo(undefined);
  setup();
});
afterEach(() => switchTo(was));

describe("buildDailyBookletAction: several days in one booklet", () => {
  const threeDays = () => setup({ library_daily_texts: [D1, D2, D3].flatMap((d) => [saved(d, "chumash"), saved(d, "tanya")]) });

  it("by day (the default): day 1's studies, then day 2's, with a front page that lists each day", async () => {
    threeDays();
    const res = await buildDailyBookletAction({ ...base, toDate: D3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fileName).toBe(`Daily study ${D1} to ${D3}.pdf`);
    expect(res.skipped).toBeUndefined();
    expect(input().items.map((i) => i.sections[0]!.blocks[0]!.he)).toEqual([D1, D2, D3].flatMap((d) => [`א chumash-${d}`, `א tanya-${d}`]));
    expect(input().items.filter((i) => i.groupTitle).map((i) => i.groupTitle)).toEqual([D1, D2, D3].map(longDate));
    expect(input().cover.contents).toHaveLength(3);
    expect(input().cover.contents.every((c) => c.text === "Chumash with Rashi, Tanya")).toBe(true);
    expect(input().cover.dateEn).toBe(`${longDate(D1)} - ${longDate(D3)}`);
    expect(input().title).toBe("Daily Study");
    // column widths are measured unless the form says otherwise
    expect(input().columns).toBe("auto");
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });

  it("by study: every day's Chumash, then every day's Tanya, and the contents list the studies", async () => {
    threeDays();
    const res = await buildDailyBookletAction({ ...base, toDate: D3, arrange: "study", columns: "wider" });
    expect(res.ok).toBe(true);
    expect(input().items.map((i) => i.sections[0]!.blocks[0]!.he)).toEqual(["chumash", "tanya"].flatMap((s) => [D1, D2, D3].map((d) => `א ${s}-${d}`)));
    expect(input().items.filter((i) => i.groupTitle).map((i) => i.groupTitle)).toEqual(["Chumash with Rashi", "Tanya"]);
    expect(input().cover.contents.map((c) => c.label)).toEqual(["Chumash with Rashi", "Tanya"]);
    expect(input().columns).toBe("wider");
  });

  it("one day is as before: no day headings, the old file name", async () => {
    threeDays();
    const res = await buildDailyBookletAction({ ...base, toDate: D1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fileName).toBe(`Daily study ${D1}.pdf`);
    expect(input().items).toHaveLength(2);
    expect(input().items.some((i) => i.groupTitle)).toBe(false);
  });

  it("refuses more than 7 days, a range that runs backwards, and unknown choices, before reading anything", async () => {
    threeDays();
    expect(await buildDailyBookletAction({ ...base, toDate: shiftIso(D1, 7) })).toEqual({ ok: false, message: "One booklet holds up to 7 days. Choose a shorter range." });
    expect(await buildDailyBookletAction({ ...base, toDate: shiftIso(D1, -1) })).toEqual({ ok: false, message: "The last day is before the first day." });
    expect((await buildDailyBookletAction({ ...base, toDate: "soon" })).ok).toBe(false);
    expect((await buildDailyBookletAction({ ...base, toDate: D2, arrange: "random" as "day" })).ok).toBe(false);
    expect((await buildDailyBookletAction({ ...base, columns: "huge" as "auto" })).ok).toBe(false);
    expect(mem.log).toEqual([]);
    expect(built.inputs).toHaveLength(0);
  });

  it("exactly 7 days is allowed", async () => {
    setup({ library_daily_texts: Array.from({ length: 7 }, (_, i) => saved(shiftIso(D1, i), "tanya")) });
    const res = await buildDailyBookletAction({ ...base, studies: ["tanya"], toDate: shiftIso(D1, 6) });
    expect(res.ok).toBe(true);
    expect(input().items).toHaveLength(7);
  });
});

describe("buildDailyBookletAction: days that are not available", () => {
  it("LIBRARY_VIA_SERVER on: names the days that are not saved, never asks the source, and builds nothing", async () => {
    switchTo("1");
    setup({ ...onlineFetcher(), library_daily_texts: [saved(D1, "chumash"), saved(D1, "tanya"), saved(D3, "chumash"), saved(D3, "tanya")] });
    const res = await buildDailyBookletAction({ ...base, toDate: D3 });
    expect(res).toEqual({ ok: false, message: `Not available: ${longDate(D2)}. Tick "Skip days that are not available" to make the booklet without it.` });
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
    expect(built.inputs).toHaveLength(0);
    expect(mem.log.some((l) => l.op === "upsert" || l.op === "insert" || l.op === "update" || l.op === "delete")).toBe(false);
  });

  it("with the skip option the booklet is made from the days that are there, and says what was left out", async () => {
    switchTo("1");
    setup({ ...onlineFetcher(), library_daily_texts: [saved(D1, "chumash"), saved(D1, "tanya"), saved(D3, "chumash"), saved(D3, "tanya")] });
    const res = await buildDailyBookletAction({ ...base, toDate: D3, skipMissing: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toEqual([longDate(D2)]);
    expect(input().items.map((i) => i.sections[0]!.blocks[0]!.he)).toEqual([D1, D3].flatMap((d) => [`א chumash-${d}`, `א tanya-${d}`]));
    expect(input().cover.contents).toHaveLength(2);
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });

  it("one day that is not saved keeps its own message (the switch's behaviour is unchanged)", async () => {
    switchTo("1");
    setup(onlineFetcher());
    const res = await buildDailyBookletAction({ ...base, skipMissing: true });
    expect(res).toEqual({ ok: false, message: "That day has not been saved yet. Your print server saves the next week every night; try again later." });
  });

  it("switch off: each missing day is fetched once through the usual path and saved for everyone; after the source fails it is not asked again", async () => {
    setup({ library_daily_texts: [saved(D1, "chumash"), saved(D1, "tanya")] });
    live.fetchShiurDay.mockImplementation(async (d: string) => (d === D2 ? { ok: false, reason: "unreachable" } : fetched(d, ["chumash", "tanya"])));
    const stopped = await buildDailyBookletAction({ ...base, toDate: D3 });
    // D1 was saved (no request), D2 failed, D3 is not saved and the source is not asked a second time
    expect(live.fetchShiurDay.mock.calls.map((c) => c[0])).toEqual([D2]);
    expect(stopped).toEqual({ ok: false, message: `Not available: ${longDate(D2)}; ${longDate(D3)}. Tick "Skip days that are not available" to make the booklet without them.` });

    live.fetchShiurDay.mockClear();
    live.fetchShiurDay.mockImplementation(async (d: string) => fetched(d, ["chumash", "tanya"]));
    const res = await buildDailyBookletAction({ ...base, toDate: D2 });
    expect(res.ok).toBe(true);
    expect(live.fetchShiurDay.mock.calls.map((c) => c[0])).toEqual([D2]);
    expect(mem.tables.library_daily_texts!.filter((r) => r.study_date === D2)).toHaveLength(2);
  });

  it("the per-person limit on fetching days still stops the booklet", async () => {
    setup({ library_daily_texts: [saved(D1, "chumash"), saved(D1, "tanya")] });
    // Building is allowed; fetching another day is over the limit.
    dbBox.client = { ...mem.client, rpc: async (_name: string, args: { p_key: string }) => ({ data: !args.p_key.startsWith("daily_fetch:"), error: null }) };
    const res = await buildDailyBookletAction({ ...base, toDate: D3, skipMissing: true });
    expect(res).toEqual({ ok: false, message: "That is a lot of days at once. Wait a few minutes and try again." });
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
    expect(built.inputs).toHaveLength(0);
  });
});
