import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDb, type Row } from "@/test/memory-db";

const auth = vi.hoisted(() => ({ agent: { id: "agent1", organizationId: "orgA", paused: false } as null | { id: string; organizationId: string; paused: boolean } }));
vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => auth.agent }));
const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => dbBox.client }));

import { GET as dailyMissing } from "./daily-missing/route";
import { POST as dailyPost } from "./daily/route";
import { parseShiurPage, shiurUrl, type ShiurDay } from "@printio/shared/library/daily/source";

// The checked-in page is for 2026-11-02, so "today" is pinned to that day (only Date is faked).
const TODAY = "2026-11-02";
const fixture = readFileSync(join(__dirname, "../../../../../../packages/shared/src/library/daily/fixtures/shiur-2026-11-02.html"), "utf8");
const realDay = (): ShiurDay => JSON.parse(JSON.stringify(parseShiurPage(fixture)));
const SOURCE_URL_CHECK = /^https:\/\/(www[.]chabad[.]org\/dailystudy|chitas-site[.]vercel[.]app\/shiur)[A-Za-z0-9_./?=&%-]{0,250}$/;
const plus = (n: number, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let mem: ReturnType<typeof memoryDb>;
const getReq = (qs: string) => new Request(`http://x/api/agents/library/daily-missing${qs}`);
const postReq = (body: unknown) => new Request("http://x/api/agents/library/daily", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const stored = () => mem.tables.library_daily_texts!;
const savedRow = (study: string, date: string, over: Row = {}): Row => ({ study, study_date: date, portion: "kept", sections: [{ heading: "h", blocks: [] }], source_url: shiurUrl(date), fetched_at: "2026-10-01T00:00:00.000Z", added_by: "user-1", ...over });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  auth.agent = { id: "agent1", organizationId: "orgA", paused: false };
  mem = memoryDb({ library_fetchers: [{ agent_id: "agent1" }], library_daily_texts: [] });
  dbBox.client = mem.client;
});
afterEach(() => vi.useRealTimers());

describe("who may call (both endpoints)", () => {
  it("401 without valid agent credentials", async () => {
    auth.agent = null;
    expect((await dailyMissing(getReq(`?from=${TODAY}&days=7`))).status).toBe(401);
    expect((await dailyPost(postReq({ date: TODAY, day: realDay() }))).status).toBe(401);
    expect(stored()).toEqual([]);
  });

  it("403 for a valid agent that is not in library_fetchers (even a school's own active agent), with the usual error format", async () => {
    auth.agent = { id: "agent-other", organizationId: "orgB", paused: false };
    for (const res of [await dailyMissing(getReq(`?from=${TODAY}&days=7`)), await dailyPost(postReq({ date: TODAY, day: realDay() }))]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "not_a_library_fetcher", message: "This agent is not allowed to fetch library pages." } });
    }
    expect(stored()).toEqual([]);
  });
});

describe("GET daily-missing", () => {
  it("lists the dates in the window that have no saved text at all, in order", async () => {
    stored().push(savedRow("tanya", TODAY), savedRow("chumash", plus(1)), savedRow("rambam1", plus(1)), savedRow("tanya", plus(3)));
    const res = await dailyMissing(getReq(`?from=${TODAY}&days=7`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ missing: [plus(2), plus(4), plus(5), plus(6)] });
  });

  it("one saved study is enough to count the day as present (the simple rule), and rows outside the window do not count", async () => {
    stored().push(savedRow("hayomyom", plus(2)), savedRow("tanya", plus(-1)), savedRow("tanya", plus(9)));
    const body = await (await dailyMissing(getReq(`?from=${TODAY}&days=3`))).json();
    expect(body).toEqual({ missing: [TODAY, plus(1)] });
  });

  it("nothing is missing when everything is saved", async () => {
    for (let i = 0; i < 7; i++) stored().push(savedRow("tanya", plus(i)));
    expect(await (await dailyMissing(getReq(`?from=${TODAY}&days=7`))).json()).toEqual({ missing: [] });
  });

  it("accepts a start within 2 days of today (either side) and up to 8 days", async () => {
    expect((await dailyMissing(getReq(`?from=${plus(-2)}&days=8`))).status).toBe(200);
    expect((await dailyMissing(getReq(`?from=${plus(2)}&days=1`))).status).toBe(200);
    const eight = await (await dailyMissing(getReq(`?from=${TODAY}&days=8`))).json();
    expect(eight.missing).toHaveLength(8);
  });

  it("400 for a start more than 2 days from today, or one that is not a real date", async () => {
    for (const from of [plus(3), plus(-3), "2026-02-30", "2026-11-2", "tomorrow", "", "2026-11-02T00:00:00Z"]) {
      const res = await dailyMissing(getReq(`?from=${encodeURIComponent(from)}&days=7`));
      expect(res.status, from).toBe(400);
      expect(await codeOf(res)).toBe("invalid_date");
    }
    const none = await dailyMissing(getReq("?days=7"));
    expect(none.status).toBe(400);
  });

  it("400 for days that is not a whole number from 1 to 8", async () => {
    for (const days of ["0", "9", "-1", "1.5", "abc", "", "7e0", "100"]) {
      const res = await dailyMissing(getReq(`?from=${TODAY}&days=${days}`));
      expect(res.status, days).toBe(400);
      expect(await codeOf(res)).toBe("invalid_days");
    }
    expect((await dailyMissing(getReq(`?from=${TODAY}`))).status).toBe(400);
  });

  it("500 (generic message) when the read fails", async () => {
    mem.state.failAll = true;
    // The guard's own lookup also reads the database, so the failure shows up as its generic 500.
    const res = await dailyMissing(getReq(`?from=${TODAY}&days=7`));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/boom/);
  });
});

describe("POST daily", () => {
  it("stores every study of the day: date, portion, sections, added_by null, and a source_url the website built itself", async () => {
    const day = realDay();
    const res = await dailyPost(postReq({ date: TODAY, day }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: day.studies.length, existing: 0 });
    expect(stored()).toHaveLength(day.studies.length);
    for (const s of day.studies) {
      const row = stored().find((r) => r.study === s.study)!;
      expect(row).toMatchObject({ study_date: TODAY, portion: s.portion, sections: s.sections, added_by: null, source_url: shiurUrl(TODAY) });
      expect(typeof row.fetched_at).toBe("string");
    }
    expect(shiurUrl(TODAY)).toMatch(SOURCE_URL_CHECK);
  });

  it("is insert-only: a second POST for the same day changes nothing (first writer wins)", async () => {
    const first = realDay();
    await dailyPost(postReq({ date: TODAY, day: first }));
    const before = JSON.parse(JSON.stringify(stored()));
    const second = realDay();
    for (const s of second.studies) {
      s.portion = "CHANGED";
      s.sections = [{ heading: "other", blocks: [{ kind: "verse", he: "x", en: "y" }] }];
    }
    const res = await dailyPost(postReq({ date: TODAY, day: second }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: 0, existing: second.studies.length });
    expect(stored()).toEqual(before);
  });

  it("fills only what is missing: a row that already exists is left exactly as it is, the others are added", async () => {
    stored().push(savedRow("tanya", TODAY));
    const day = realDay();
    const res = await dailyPost(postReq({ date: TODAY, day }));
    expect(await res.json()).toEqual({ ok: true, inserted: day.studies.length - 1, existing: 1 });
    expect(stored().find((r) => r.study === "tanya")).toEqual(savedRow("tanya", TODAY));
    expect(stored()).toHaveLength(day.studies.length);
  });

  it("a url or source_url in the body (top level or inside the day) is ignored: the website builds the address from the date", async () => {
    const day = realDay() as ShiurDay & Record<string, unknown>;
    day.url = "https://evil.example/x";
    day.source_url = "https://evil.example/y";
    (day.studies[0] as unknown as Record<string, unknown>).source_url = "https://evil.example/z";
    const res = await dailyPost(postReq({ date: TODAY, day, url: "https://evil.example/a", source_url: "https://evil.example/b", added_by: "someone" }));
    expect(res.status).toBe(200);
    for (const row of stored()) {
      expect(row.source_url).toBe(shiurUrl(TODAY));
      expect(row.added_by).toBeNull();
      expect(JSON.stringify(row)).not.toContain("evil.example");
    }
  });

  it("400 when the date is not within 10 days of today, or not a real date", async () => {
    for (const date of [plus(11), plus(-11), "2026-02-30", "2026-11-2", "", "next week"]) {
      const res = await dailyPost(postReq({ date, day: { ...realDay(), date } }));
      expect(res.status, date).toBe(400);
      expect(await codeOf(res)).toBe("invalid_date");
    }
    expect(stored()).toEqual([]);
    // The edges are fine.
    for (const date of [plus(10), plus(-10)]) expect((await dailyPost(postReq({ date, day: { ...realDay(), date } }))).status).toBe(200);
  });

  it("400 when the day's own date is not the date it is posted for", async () => {
    const res = await dailyPost(postReq({ date: plus(1), day: realDay() }));
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("date_mismatch");
    expect(stored()).toEqual([]);
  });

  it("400 for a day that is not the shape parseShiurPage returns (and nothing is stored)", async () => {
    const good = realDay();
    const mut = (f: (d: ShiurDay & Record<string, any>) => void) => {
      const d = realDay() as ShiurDay & Record<string, any>;
      f(d);
      return d;
    };
    const bad: Record<string, unknown> = {
      "no studies": { date: TODAY, studies: [] },
      "studies missing": { date: TODAY },
      "not an object": "text",
      "unknown study key": mut((d) => (d.studies[0]!.study = "evil" as never)),
      "a study the table allows but the library does not offer": mut((d) => (d.studies[0]!.study = "tehillim" as never)),
      "same study twice": mut((d) => d.studies.push(JSON.parse(JSON.stringify(d.studies[0])))),
      "empty portion": mut((d) => (d.studies[0]!.portion = "")),
      "portion over 300 characters": mut((d) => (d.studies[0]!.portion = "x".repeat(301))),
      "no sections": mut((d) => (d.studies[0]!.sections = [])),
      "section without blocks": mut((d) => (d.studies[0]!.sections[0]!.blocks = [])),
      "unknown block kind": mut((d) => (d.studies[0]!.sections[0]!.blocks[0]!.kind = "script" as never)),
      "block text is not a string": mut((d) => (d.studies[0]!.sections[0]!.blocks[0]!.he = 5 as never)),
      "one block's text over the limit": mut((d) => (d.studies[0]!.sections[0]!.blocks[0]!.en = "x".repeat(20_001))),
      "more studies than the library offers": { date: TODAY, studies: Array.from({ length: 6 }, () => good.studies[0]) },
    };
    for (const [name, day] of Object.entries(bad)) {
      const res = await dailyPost(postReq({ date: TODAY, day }));
      expect(res.status, name).toBe(400);
      expect(await codeOf(res), name).toBe("invalid_day");
    }
    expect(stored()).toEqual([]);
  });

  it("accepts a portion of exactly 300 characters and a day with only some studies", async () => {
    const day = realDay();
    day.studies = [day.studies[0]!];
    day.studies[0]!.portion = "p".repeat(300);
    const res = await dailyPost(postReq({ date: TODAY, day }));
    expect(res.status).toBe(200);
    expect(stored()).toHaveLength(1);
  });

  it("400 when the body has no day or date, or is not JSON; the usual 400 for a body that is not an object", async () => {
    expect((await dailyPost(postReq({ date: TODAY }))).status).toBe(400);
    expect((await dailyPost(postReq({ day: realDay() }))).status).toBe(400);
    const notJson = await dailyPost(postReq("not json"));
    expect(notJson.status).toBe(400);
    expect(await codeOf(notJson)).toBe("invalid_json");
    expect((await dailyPost(postReq([]))).status).toBe(400);
    expect(stored()).toEqual([]);
  });

  it("413 for a day whose JSON is over 1.5 MB (even when every single field is within its own limit), and for a body over the request limit", async () => {
    const day = realDay();
    const block = { kind: "verse" as const, he: "x".repeat(19_000), en: "" };
    day.studies = [{ study: "tanya", portion: "big", sections: [{ heading: "h", blocks: Array.from({ length: 80 }, () => block) }] }];
    expect(JSON.stringify(day).length).toBeGreaterThan(1_500_000);
    const res = await dailyPost(postReq({ date: TODAY, day }));
    expect(res.status).toBe(413);
    expect(await codeOf(res)).toBe("too_large");
    const huge = await dailyPost(postReq(JSON.stringify({ date: TODAY, day, pad: "y".repeat(200_000) })));
    expect(huge.status).toBe(413);
    expect(stored()).toEqual([]);
  });

  it("a day just under 1.5 MB is accepted", async () => {
    const day = realDay();
    const block = { kind: "verse" as const, he: "x".repeat(19_000), en: "" };
    day.studies = [{ study: "tanya", portion: "big", sections: [{ heading: "h", blocks: Array.from({ length: 78 }, () => block) }] }];
    expect(JSON.stringify(day).length).toBeLessThan(1_500_000);
    expect((await dailyPost(postReq({ date: TODAY, day }))).status).toBe(200);
  });

  it("500 (generic message, no database text) when the write fails", async () => {
    const real = (mem.client as { from: (t: string) => unknown }).from;
    dbBox.client = {
      ...mem.client,
      from: (t: string) => {
        if (t !== "library_daily_texts") return real(t);
        const q: Record<string, unknown> = { upsert: () => q, select: () => q, then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "secret db detail" } }) };
        return q;
      },
    };
    const res = await dailyPost(postReq({ date: TODAY, day: realDay() }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret/);
  });

  it("writes with ignoreDuplicates on (study, study_date): the database itself refuses an overwrite, even in a race", async () => {
    const real = (mem.client as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> }).from;
    let seen: unknown;
    dbBox.client = {
      ...mem.client,
      from: (t: string) => {
        const q = real(t)!;
        if (t === "library_daily_texts") {
          const up = q.upsert!;
          q.upsert = (v: unknown, o: unknown) => ((seen = o), up(v, o));
        }
        return q;
      },
    };
    await dailyPost(postReq({ date: TODAY, day: realDay() }));
    expect(seen).toEqual({ onConflict: "study,study_date", ignoreDuplicates: true });
  });
});
