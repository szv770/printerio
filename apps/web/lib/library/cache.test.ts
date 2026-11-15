import { describe, expect, it, vi } from "vitest";
import { fakeSupabase, failure, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("server-only", () => ({}));

import {
  enqueueLibraryFetch,
  FAILED_RETRY_MS,
  FETCHER_ONLINE_MS,
  getFreshPage,
  libraryKey,
  libraryTtlMs,
  EMPTY_ENTRY_TTL_MS,
  libraryViaServer,
  MAX_QUEUED_JOBS,
} from "./cache";

const db = (responder: (c: FakeCall) => FakeResult) => fakeSupabase(responder);
const asDb = (f: ReturnType<typeof fakeSupabase>) => f.client as never;
const who = { organizationId: "org1", userId: "u1" };

describe("libraryViaServer (the switch)", () => {
  it("is OFF unless the variable is 1 or true", () => {
    const was = process.env.LIBRARY_VIA_SERVER;
    try {
      delete process.env.LIBRARY_VIA_SERVER;
      expect(libraryViaServer()).toBe(false);
      for (const v of ["", "0", "false", "yes", "on", "2", " "]) {
        process.env.LIBRARY_VIA_SERVER = v;
        expect(libraryViaServer(), v).toBe(false);
      }
      for (const v of ["1", "true", "TRUE", " 1 "]) {
        process.env.LIBRARY_VIA_SERVER = v;
        expect(libraryViaServer(), v).toBe(true);
      }
    } finally {
      if (was === undefined) delete process.env.LIBRARY_VIA_SERVER;
      else process.env.LIBRARY_VIA_SERVER = was;
    }
  });
});

describe("libraryKey (only the allowed shapes)", () => {
  it("builds keys from validated shapes", () => {
    expect(libraryKey({ kind: "likkutei", volume: 12 })).toBe("likkutei:12");
    expect(libraryKey({ kind: "list", section: "maamorim" })).toBe("list:maamorim:current");
    expect(libraryKey({ kind: "list", section: "maamorim", year: "5710" })).toBe("list:maamorim:5710");
    expect(libraryKey({ kind: "list", section: "all", year: "5690_5710" })).toBe("list:all:5690_5710");
    expect(libraryKey({ kind: "entry", path: "/maamorim/123" })).toBe("entry:/maamorim/123");
    expect(libraryKey({ kind: "entry", path: "/all/5711-01-01" })).toBe("entry:/all/5711-01-01");
  });

  it("refuses everything else", () => {
    const bad: unknown[] = [
      { kind: "likkutei", volume: 0 },
      { kind: "likkutei", volume: 100 },
      { kind: "likkutei", volume: 1.5 },
      { kind: "likkutei", volume: "3" },
      { kind: "list", section: "secrets" },
      { kind: "list", section: "all", year: "1999" },
      { kind: "list", section: "all", year: "5710/../x" },
      { kind: "entry", path: "https://evil.example/maamorim/1" },
      { kind: "entry", path: "/maamorim/1/../../x" },
      { kind: "entry", path: "/maamorim/1?x=1" },
      { kind: "nope" },
      null,
      "likkutei:1",
      {},
    ];
    for (const b of bad) expect(libraryKey(b as never), JSON.stringify(b)).toBeNull();
  });
});

describe("TTLs", () => {
  it("lists and Likkutei volumes 24 hours, single entries 7 days", () => {
    expect(libraryTtlMs({ kind: "likkutei", volume: 1 })).toBe(24 * 3600_000);
    expect(libraryTtlMs({ kind: "list", section: "all" })).toBe(24 * 3600_000);
    expect(libraryTtlMs({ kind: "entry", path: "/maamorim/1" })).toBe(7 * 24 * 3600_000);
  });

  it("an entry with no sections at all is kept for only 10 minutes (it may just not be published yet); a list or volume is never short-lived", () => {
    expect(EMPTY_ENTRY_TTL_MS).toBe(10 * 60_000);
    const entry = { kind: "entry", path: "/maamorim/1" } as const;
    expect(libraryTtlMs(entry, [])).toBe(10 * 60_000);
    expect(libraryTtlMs(entry, [{ title: "t", groups: [] }])).toBe(7 * 24 * 3600_000);
    expect(libraryTtlMs({ kind: "list", section: "all" }, [])).toBe(24 * 3600_000);
    expect(libraryTtlMs({ kind: "likkutei", volume: 1 }, [])).toBe(24 * 3600_000);
  });
});

describe("getFreshPage", () => {
  it("returns the payload of an unexpired row and asks only for unexpired rows", async () => {
    const f = db(() => ok({ payload: { years: [], entries: [] } }));
    expect(await getFreshPage(asDb(f), "list:all:current")).toEqual({ years: [], entries: [] });
    const c = f.calls[0]!;
    expect(c.table).toBe("library_pages");
    expect(c.filters).toContainEqual(["eq", "key", "list:all:current"]);
    expect(c.filters.some((x) => x[0] === "gt" && x[1] === "expires_at")).toBe(true);
  });

  it("returns null when there is nothing fresh, or the read fails", async () => {
    expect(await getFreshPage(asDb(db(() => ok(null))), "k")).toBeNull();
    expect(await getFreshPage(asDb(db(() => failure())), "k")).toBeNull();
  });
});

describe("enqueueLibraryFetch", () => {
  const ref = { kind: "likkutei", volume: 3 } as const;

  /** A scripted database: active job (if any), recent failure (if any), queued count, and what the insert answers. */
  function script(o: { active?: unknown; failed?: unknown; queued?: number; insert?: FakeResult } = {}) {
    return db((c) => {
      if (c.table !== "server_jobs") return ok(null);
      if (c.op === "insert") return o.insert ?? ok({ id: "new-job" });
      const status = c.filters.find((x) => x[0] === "eq" && x[1] === "status") as [string, string, string] | undefined;
      const inStatus = c.filters.find((x) => x[0] === "in" && x[1] === "status") as [string, string, string[]] | undefined;
      if (c.columns === "id" && c.single === undefined) return { data: null, error: null, count: o.queued ?? 0 };
      if (status?.[2] === "failed") return ok(o.failed ?? null);
      if (inStatus) return ok(o.active ?? null);
      return ok(null);
    });
  }

  it("inserts a queued job with structured params, the key and the requester (no URL anywhere)", async () => {
    const f = script();
    const res = await enqueueLibraryFetch(asDb(f), { ...who, ref });
    expect(res).toEqual({ kind: "queued", jobId: "new-job" });
    const ins = f.calls.find((c) => c.op === "insert")!;
    expect(ins.values).toEqual({
      kind: "library_fetch",
      organization_id: "org1",
      requested_by: "u1",
      params: { kind: "likkutei", volume: 3 },
      dedupe_key: "likkutei:3",
    });
    expect(JSON.stringify(ins.values)).not.toMatch(/https?:/);
  });

  it("params carry only the validated fields of the reference (nothing extra a caller smuggled in)", async () => {
    const f = script();
    await enqueueLibraryFetch(asDb(f), { ...who, ref: { kind: "entry", path: "/maamorim/9", url: "https://evil.example" } as never });
    expect((f.calls.find((c) => c.op === "insert")!.values as { params: unknown }).params).toEqual({ kind: "entry", path: "/maamorim/9" });
  });

  it("returns the existing active job instead of inserting (dedupe)", async () => {
    const f = script({ active: { id: "job-active" } });
    expect(await enqueueLibraryFetch(asDb(f), { ...who, ref })).toEqual({ kind: "active", jobId: "job-active" });
    expect(f.calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("when two people race and the unique index refuses the insert, returns the winner's job", async () => {
    let selects = 0;
    const f = db((c) => {
      if (c.op === "insert") return { data: null, error: { message: "duplicate key", code: "23505" } as never };
      if (c.table === "server_jobs" && c.columns === "id" && c.single === undefined) return { data: null, error: null, count: 0 };
      const inStatus = c.filters.some((x) => x[0] === "in" && x[1] === "status");
      if (inStatus) return ok(++selects >= 2 ? { id: "winner" } : null); // first look: none; after the conflict: the winner
      return ok(null);
    });
    expect(await enqueueLibraryFetch(asDb(f), { ...who, ref })).toEqual({ kind: "active", jobId: "winner" });
  });

  it("a failed job for the same key younger than 5 minutes is returned as-is, with its error", async () => {
    const f = script({ failed: { id: "job-failed", error: "The library page looks different today." } });
    const res = await enqueueLibraryFetch(asDb(f), { ...who, ref });
    expect(res).toEqual({ kind: "recent_failure", jobId: "job-failed", error: "The library page looks different today." });
    expect(f.calls.some((c) => c.op === "insert")).toBe(false);
    const q = f.calls.find((c) => c.filters.some((x) => x[0] === "eq" && x[2] === "failed"))!;
    const gte = q.filters.find((x) => x[0] === "gte" && x[1] === "updated_at");
    expect(gte).toBeTruthy();
    const age = Date.now() - Date.parse(gte![2] as string);
    expect(Math.abs(age - FAILED_RETRY_MS)).toBeLessThan(5_000);
    expect(FAILED_RETRY_MS).toBe(5 * 60_000);
  });

  it("refuses new work when the queue already holds the cap", async () => {
    const f = script({ queued: MAX_QUEUED_JOBS });
    expect(await enqueueLibraryFetch(asDb(f), { ...who, ref })).toEqual({ kind: "busy" });
    expect(f.calls.some((c) => c.op === "insert")).toBe(false);
    expect(MAX_QUEUED_JOBS).toBe(50);
    expect(await enqueueLibraryFetch(asDb(script({ queued: MAX_QUEUED_JOBS - 1 })), { ...who, ref })).toEqual({ kind: "queued", jobId: "new-job" });
  });

  it("refuses an invalid reference without touching the database", async () => {
    const f = script();
    expect(await enqueueLibraryFetch(asDb(f), { ...who, ref: { kind: "entry", path: "/etc/passwd" } })).toEqual({ kind: "invalid" });
    expect(f.calls).toHaveLength(0);
  });

  it("reports an error (never throws) when the database fails", async () => {
    const f = db((c) => (c.op === "insert" ? failure("boom") : c.columns === "id" && c.single === undefined ? { data: null, error: null, count: 0 } : ok(null)));
    expect(await enqueueLibraryFetch(asDb(f), { ...who, ref })).toEqual({ kind: "error" });
  });
});

describe("onlineFetcherExists", () => {
  async function run(fetchers: unknown, agents: unknown) {
    const { onlineFetcherExists } = await import("./cache");
    const f = db((c) => (c.table === "library_fetchers" ? ok(fetchers) : c.table === "agents" ? ok(agents) : ok(null)));
    return { yes: await onlineFetcherExists(asDb(f)), calls: f.calls };
  }

  it("is true when a registered fetcher has a fresh heartbeat (last_seen_at within 2 minutes)", async () => {
    const r = await run([{ agent_id: "a1" }], [{ id: "a1" }]);
    expect(r.yes).toBe(true);
    const q = r.calls.find((c) => c.table === "agents")!;
    expect(q.filters).toContainEqual(["in", "id", ["a1"]]);
    expect(q.filters).toContainEqual(["eq", "status", "active"]);
    const gte = q.filters.find((x) => x[0] === "gte" && x[1] === "last_seen_at")!;
    expect(Math.abs(Date.now() - Date.parse(gte[2] as string) - FETCHER_ONLINE_MS)).toBeLessThan(5_000);
    expect(FETCHER_ONLINE_MS).toBe(2 * 60_000);
  });

  it("is false when nobody is registered (and does not even look at agents)", async () => {
    const r = await run([], []);
    expect(r.yes).toBe(false);
    expect(r.calls.some((c) => c.table === "agents")).toBe(false);
  });

  it("is false when the registered servers have no recent heartbeat", async () => {
    expect((await run([{ agent_id: "a1" }], [])).yes).toBe(false);
  });

  it("is false when the database fails", async () => {
    const { onlineFetcherExists } = await import("./cache");
    expect(await onlineFetcherExists(asDb(db(() => failure())))).toBe(false);
  });
});
