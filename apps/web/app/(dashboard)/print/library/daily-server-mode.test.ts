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

import { buildDailyBookletAction, dailyDayAction } from "./daily-actions";
import { shiurUrl } from "@printio/shared/library/daily/source";

const DATE = new Date().toISOString().slice(0, 10);
const NOT_SAVED = "That day has not been saved yet. Your print server saves the next week every night; try again later.";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const savedRow = (study: string, portion: string): Row => ({ study, study_date: DATE, portion, sections: [{ heading: "h", blocks: [{ kind: "verse", num: "1", he: "א", en: "a" }] }], source_url: shiurUrl(DATE) });
const onlineFetcher = (): Record<string, Row[]> => ({ library_fetchers: [{ agent_id: "a1" }], agents: [{ id: "a1", status: "active", last_seen_at: minutesAgo(0.5) }] });

let mem: ReturnType<typeof memoryDb>;
function setup(tables: Record<string, Row[]> = {}) {
  mem = memoryDb({ library_daily_texts: [], library_fetchers: [], agents: [], ...tables });
  dbBox.client = mem.client;
}
const was = process.env.LIBRARY_VIA_SERVER;
const switchTo = (v: string | undefined) => (v === undefined ? delete process.env.LIBRARY_VIA_SERVER : (process.env.LIBRARY_VIA_SERVER = v));
const reads = () => mem.log.map((l) => `${l.table}:${l.op}`);

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionOrRedirect.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1", role: "org_admin", early_tools: false } });
  live.fetchShiurDay.mockResolvedValue({ ok: false, reason: "unreachable" });
  setup();
});
afterEach(() => switchTo(was));

describe("LIBRARY_VIA_SERVER OFF (the default): today's behaviour, the website fetches a missing day itself", () => {
  for (const value of [undefined, "", "0", "false", "off"]) {
    it(`switch ${JSON.stringify(value)}: asks the source (rate limit first), never looks at the print servers`, async () => {
      switchTo(value);
      setup(onlineFetcher());
      const res = await dailyDayAction(DATE);
      expect(live.fetchShiurDay).toHaveBeenCalledWith(DATE);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toMatch(/could not get the daily study/i);
      expect(reads().filter((r) => r.startsWith("library_fetchers") || r.startsWith("agents"))).toEqual([]);
    });
  }

  it("a day already saved is returned without any fetch (unchanged)", async () => {
    switchTo(undefined);
    setup({ library_daily_texts: [savedRow("tanya", "Tanya portion")] });
    const res = await dailyDayAction(DATE);
    expect(res).toEqual({ ok: true, items: [{ study: "tanya", label: "Tanya", portion: "Tanya portion" }] });
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });
});

describe("LIBRARY_VIA_SERVER ON: reads the saved text only and never fetches live", () => {
  beforeEach(() => switchTo("1"));

  it("a saved day is listed as before", async () => {
    setup({ library_daily_texts: [savedRow("tanya", "T"), savedRow("chumash", "C")] });
    const res = await dailyDayAction(DATE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items.map((i) => i.study)).toEqual(["chumash", "tanya"]);
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });

  it("a day that is not saved: the plain message, no live fetch, nothing written, no fetch job queued", async () => {
    setup(onlineFetcher());
    const res = await dailyDayAction(DATE);
    expect(res).toEqual({ ok: false, message: NOT_SAVED });
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
    expect(mem.log.some((l) => l.op === "upsert" || l.op === "insert" || l.op === "update" || l.op === "delete")).toBe(false);
    expect(mem.tables.library_daily_texts).toEqual([]);
  });

  it("says so when no print server is online (none registered, or its last heartbeat is old)", async () => {
    setup();
    const none = await dailyDayAction(DATE);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).toMatch(/no print server is online/i);
    setup({ library_fetchers: [{ agent_id: "a1" }], agents: [{ id: "a1", status: "active", last_seen_at: minutesAgo(10) }] });
    const stale = await dailyDayAction(DATE);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.message).toMatch(/no print server is online/i);
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });

  it("building a booklet for an unsaved day gives the same message instead of fetching", async () => {
    setup(onlineFetcher());
    const res = await buildDailyBookletAction({ date: DATE, studies: ["tanya"], language: "both", sheet: "letter" });
    expect(res).toEqual({ ok: false, message: NOT_SAVED });
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });

  it("the people and date checks are the same as ever", async () => {
    setup(onlineFetcher());
    expect((await dailyDayAction("tomorrow")).ok).toBe(false);
    requireSessionOrRedirect.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1", role: "staff", early_tools: false } });
    expect((await dailyDayAction(DATE)).ok).toBe(false);
    expect(live.fetchShiurDay).not.toHaveBeenCalled();
  });
});
