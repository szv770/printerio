import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShiurPage, shiurUrl } from "@printio/shared/library/daily/source";
import { CloudApiError, CloudNetworkError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import {
  createLibraryWorker,
  startLibraryWorker,
  DAILY_DAYS,
  DAILY_MAX_ERRORS,
  DAILY_RETRY_MS,
  DAILY_STARTUP_MS,
  FORBIDDEN_MS,
  IDLE_MS,
  INITIAL_DELAY_MS,
  localDateKey,
  MIN_GAP_MS,
  msUntilNextDailyRun,
} from "../src/library-worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const shiurFixture = readFileSync(join(here, "../../../packages/shared/src/library/daily/fixtures/shiur-2026-11-02.html"), "utf8");
const likkuteiFixture = readFileSync(join(here, "../../../packages/shared/src/library/fixtures/likkutei-volume.html"), "utf8");

/** The checked-in page is for 2026-11-02; the same page for another date (the page names its date in its markers). */
const pageFor = (date: string) => shiurFixture.replaceAll("2026_11_02", date.replaceAll("-", "_"));
const html = (text: string, init: ResponseInit = {}) => new Response(text, { status: 200, headers: { "content-type": "text/html" }, ...init });

// "Now" is Sunday 15 November 2026 at 02:00 LOCAL time (the worker works in its own computer's time zone).
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const plus = (key: string, n: number) => localDateKey(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) + n, 12).getTime());
const TODAY = "2026-11-15";
const WEEK = Array.from({ length: 7 }, (_, i) => plus(TODAY, i));

function makeLogger() {
  const calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => void calls.push({ level, msg, fields });
  const logger: Logger = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error"), child: () => logger };
  return { logger, calls, at: (...levels: string[]) => calls.filter((c) => levels.includes(c.level)) };
}

function makeCloud() {
  return {
    claimLibraryJob: vi.fn(async (): Promise<{ jobId: string; kind: string; params: unknown } | null> => null),
    completeLibraryJob: vi.fn(async (_jobId: string, _payload: unknown): Promise<void> => undefined),
    failLibraryJob: vi.fn(async (_jobId: string, _error: string): Promise<void> => undefined),
    getMissingDailyDates: vi.fn(async (_from: string, _days: number): Promise<string[]> => []),
    postDailyText: vi.fn(async (_date: string, _day: unknown): Promise<void> => undefined),
  };
}

/** A worker on fake timers (Date and setTimeout both fake), asking a fake cloud and a fake source that records when it was asked. */
function setup(over: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; start?: Date } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(over.start ?? at(2026, 11, 15, 2, 0));
  const log = makeLogger();
  const cloud = makeCloud();
  const fetched: Array<{ url: string; at: number; headers: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    fetched.push({ url, at: Date.now(), headers: init?.headers });
    if (over.fetchImpl) return over.fetchImpl(url, init);
    const date = new URL(url).searchParams.get("from") ?? "";
    return html(pageFor(date));
  });
  const worker = createLibraryWorker({ cloud, logger: log.logger, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { worker, log, cloud, fetchImpl, fetched };
}

/** One daily pass on the fake clock, with time moving on so the 5 s gaps between days pass. */
async function runPass(w: { dailyPass(): Promise<number> }): Promise<number> {
  const run = w.dailyPass();
  await vi.advanceTimersByTimeAsync(120_000);
  return run;
}

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the clock helpers", () => {
  it("localDateKey is the local calendar date", () => {
    expect(localDateKey(at(2026, 11, 15, 0, 0).getTime())).toBe("2026-11-15");
    expect(localDateKey(at(2026, 11, 15, 23, 59).getTime())).toBe("2026-11-15");
    expect(localDateKey(at(2026, 1, 5, 12).getTime())).toBe("2026-01-05");
  });

  it("msUntilNextDailyRun: the next 03:30 local, tomorrow's when it is 03:30 or later", () => {
    const h = 3_600_000;
    expect(msUntilNextDailyRun(at(2026, 11, 15, 2, 0).getTime())).toBe(1.5 * h);
    expect(msUntilNextDailyRun(at(2026, 11, 15, 3, 29).getTime())).toBe(60_000);
    expect(msUntilNextDailyRun(at(2026, 11, 15, 3, 30).getTime())).toBe(24 * h);
    expect(msUntilNextDailyRun(at(2026, 11, 15, 23, 0).getTime())).toBe(4.5 * h);
    // across a month end
    expect(msUntilNextDailyRun(at(2026, 11, 30, 12, 0).getTime())).toBe(15.5 * h);
  });
});

describe("switched off, or nothing to run: no daily timer, no call", () => {
  it("startLibraryWorker(enabled:false): nothing is created, the cloud is never asked, for days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(2026, 11, 15, 2, 0));
    const log = makeLogger();
    const cloud = makeCloud();
    const fetchImpl = vi.fn();
    expect(startLibraryWorker({ enabled: false, cloud, logger: log.logger, fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * 24 * 3_600_000);
    expect(cloud.getMissingDailyDates).not.toHaveBeenCalled();
    expect(cloud.postDailyText).not.toHaveBeenCalled();
    expect(cloud.claimLibraryJob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enabled: two timers (the job loop and the daily one); stop() clears both and nothing runs afterwards", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(2026, 11, 15, 2, 0));
    const cloud = makeCloud();
    const w = startLibraryWorker({ enabled: true, cloud, logger: makeLogger().logger })!;
    expect(vi.getTimerCount()).toBe(2);
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 24 * 3_600_000);
    expect(cloud.getMissingDailyDates).not.toHaveBeenCalled();
  });

  it("a cloud without the two daily calls (an older client) gets no daily timer at all", async () => {
    vi.useFakeTimers();
    const { getMissingDailyDates: _a, postDailyText: _b, ...jobsOnly } = makeCloud();
    const w = createLibraryWorker({ cloud: jobsOnly, logger: makeLogger().logger });
    w.start();
    expect(vi.getTimerCount()).toBe(1);
    await w.dailyPass();
    w.stop();
  });
});

describe("when it runs: about 2 minutes after start, then every night at 03:30 local, once a day", () => {
  it("started at 02:00: looks once at 02:02, not again at 03:30 the same day, then at 03:30 on each following night", async () => {
    const { worker, cloud } = setup();
    worker.start();
    await vi.advanceTimersByTimeAsync(DAILY_STARTUP_MS - 1000);
    expect(cloud.getMissingDailyDates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledWith(TODAY, DAILY_DAYS);
    // 03:30 the same day: already done today
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    // 03:30 the next day, and the one after
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(2);
    expect(cloud.getMissingDailyDates).toHaveBeenLastCalledWith("2026-11-16", 7);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(3);
    expect(cloud.getMissingDailyDates).toHaveBeenLastCalledWith("2026-11-17", 7);
    worker.stop();
  });

  it("started in the evening: looks 2 minutes after start AND again at 03:30 (a new day)", async () => {
    const { worker, cloud } = setup({ start: at(2026, 11, 15, 20, 0) });
    worker.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7 * 3_600_000 + 20 * 60_000); // to 03:23
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000); // past 03:30
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(2);
    expect(cloud.getMissingDailyDates).toHaveBeenLastCalledWith("2026-11-16", 7);
    worker.stop();
  });

  it("started at 03:29: the startup look (03:31) and the 03:30 look do not both run", async () => {
    const { worker, cloud } = setup({ start: at(2026, 11, 15, 3, 29) });
    worker.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it("uses exactly one daily timer at any time", async () => {
    const { worker } = setup();
    worker.start();
    await vi.advanceTimersByTimeAsync(DAILY_STARTUP_MS + 1000);
    expect(vi.getTimerCount()).toBe(2); // the job loop's and the nightly one
    worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("what a pass does", () => {
  it("fetches each missing day with the rebuilt address, parses it, and posts { date, day } for it, in date order", async () => {
    const { worker, cloud, fetched } = setup();
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[2]!, WEEK[0]!]);
    const next = await runPass(worker);
    expect(fetched.map((f) => f.url)).toEqual([shiurUrl(WEEK[0]!), shiurUrl(WEEK[2]!)]);
    expect(fetched[0]!.headers).toEqual({ "user-agent": "Printio/1.0 (daily study booklet)", accept: "text/html" });
    expect(cloud.postDailyText).toHaveBeenCalledTimes(2);
    for (const [i, date] of [WEEK[0]!, WEEK[2]!].entries()) {
      const [postedDate, day] = cloud.postDailyText.mock.calls[i]!;
      expect(postedDate).toBe(date);
      expect(day).toEqual(parseShiurPage(pageFor(date)));
      expect((day as { date: string }).date).toBe(date);
    }
    // then it waits for the next 03:30 local (at most a day away)
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it("does nothing when nothing is missing", async () => {
    const { worker, cloud, fetchImpl } = setup();
    await runPass(worker);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cloud.postDailyText).not.toHaveBeenCalled();
  });

  it("a second pass the same day does not ask or fetch again", async () => {
    const { worker, cloud, fetchImpl } = setup();
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!]);
    await runPass(worker);
    await runPass(worker);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores what the website should never send: dates outside the next 7 days, junk, repeats; the address is never taken from the answer", async () => {
    const { worker, cloud, fetched } = setup();
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[1]!, WEEK[1]!, plus(TODAY, 7), plus(TODAY, -1), "2026-02-30", "https://evil.example/x", "../../etc", "20261116", WEEK[0]!]);
    await runPass(worker);
    expect(fetched.map((f) => f.url)).toEqual([shiurUrl(WEEK[0]!), shiurUrl(WEEK[1]!)]);
    expect(fetched.every((f) => new URL(f.url).origin === "https://chitas-site.vercel.app")).toBe(true);
  });

  it("an unfetchable day, a page that does not parse, and a page for another day are each skipped with ONE log line; the others still go", async () => {
    const dates = [WEEK[0]!, WEEK[1]!, WEEK[2]!, WEEK[3]!];
    const { worker, cloud, log } = setup({
      fetchImpl: async (url) => {
        const date = new URL(url).searchParams.get("from")!;
        if (date === dates[0]) throw new TypeError("fetch failed");
        if (date === dates[1]) return html("<html><body>Not what we expect</body></html>");
        if (date === dates[2]) return html(pageFor("2026-11-30")); // a page that names a different day
        return html(pageFor(date));
      },
    });
    cloud.getMissingDailyDates.mockResolvedValue(dates);
    await runPass(worker);
    expect(cloud.postDailyText).toHaveBeenCalledTimes(1);
    expect(cloud.postDailyText.mock.calls[0]![0]).toBe(dates[3]);
    const skipped = log.calls.filter((c) => c.msg === "daily study text: day skipped");
    expect(skipped.map((c) => c.fields?.date)).toEqual([dates[0], dates[1], dates[2]]);
    expect(log.at("warn", "error")).toHaveLength(0);
  });

  it("a 404, a server error and an oversized page skip the day too", async () => {
    const { worker, cloud, log } = setup({
      fetchImpl: async (url) => {
        const date = new URL(url).searchParams.get("from")!;
        if (date === WEEK[0]) return new Response("nope", { status: 404 });
        if (date === WEEK[1]) return new Response("oops", { status: 503 });
        return html("x".repeat(10), { headers: { "content-length": String(4 * 1024 * 1024) } });
      },
    });
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!, WEEK[1]!, WEEK[2]!]);
    await runPass(worker);
    expect(cloud.postDailyText).not.toHaveBeenCalled();
    expect(log.calls.filter((c) => c.msg === "daily study text: day skipped")).toHaveLength(3);
  });

  it("a redirect to another site is never followed; the day is skipped", async () => {
    const { worker, cloud, fetchImpl } = setup({
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/shiur" } }),
    });
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!]);
    await runPass(worker);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cloud.postDailyText).not.toHaveBeenCalled();
  });

  it("a hanging source times out after the worker's time limit and the day is skipped", async () => {
    vi.useFakeTimers();
    // Pin the clock: fake timers start at the REAL date otherwise, and WEEK starts at TODAY (this test broke on 2026-11-16).
    vi.setSystemTime(at(2026, 11, 15, 2, 0));
    const log = makeLogger();
    const cloud = makeCloud();
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!]);
    const worker = createLibraryWorker({
      cloud,
      logger: log.logger,
      timeoutMs: 15_000,
      fetchImpl: ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch,
    });
    const run = worker.dailyPass();
    await vi.advanceTimersByTimeAsync(16_000);
    await run;
    expect(cloud.postDailyText).not.toHaveBeenCalled();
    expect(log.calls.filter((c) => c.msg === "daily study text: day skipped")).toHaveLength(1);
  });

  it("the website refusing one day (a 4xx) skips that day only; a 5xx or network error stops the pass and it is tried again soon", async () => {
    const a = setup();
    a.cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!, WEEK[1]!]);
    a.cloud.postDailyText.mockRejectedValueOnce(new CloudApiError("bad", "invalid_day", 400));
    await runPass(a.worker);
    expect(a.cloud.postDailyText).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    const b = setup();
    b.cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!, WEEK[1]!]);
    b.cloud.postDailyText.mockRejectedValueOnce(new CloudNetworkError("down", undefined));
    expect(await runPass(b.worker)).toBe(DAILY_RETRY_MS);
    expect(b.cloud.postDailyText).toHaveBeenCalledTimes(1);
    // not counted as done: the next pass asks again
    b.cloud.postDailyText.mockResolvedValue(undefined);
    await runPass(b.worker);
    expect(b.cloud.getMissingDailyDates).toHaveBeenCalledTimes(2);
  });
});

describe("politeness: the 5 s gap, shared with the job loop", () => {
  it("at least 5 s between the end of one request to the source and the start of the next", async () => {
    const { worker, cloud, fetched } = setup();
    cloud.getMissingDailyDates.mockResolvedValue(WEEK);
    const run = worker.dailyPass();
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(fetched).toHaveLength(7);
    for (let i = 1; i < fetched.length; i++) expect(fetched[i]!.at - fetched[i - 1]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(cloud.postDailyText).toHaveBeenCalledTimes(7);
  });

  it("the gap is shared with the library job loop: a day fetched right after a library page waits out the gap", async () => {
    const { worker, cloud, fetched } = setup({
      fetchImpl: async (url) => (url.startsWith("https://www.mafteiach.app") ? html(likkuteiFixture) : html(pageFor(new URL(url).searchParams.get("from")!))),
    });
    cloud.claimLibraryJob.mockResolvedValueOnce({ jobId: "j1", kind: "library_fetch", params: { kind: "likkutei", volume: 2 } });
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!]);
    await worker.tick();
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    const run = worker.dailyPass();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(fetched).toHaveLength(2);
    expect(fetched[1]!.at - fetched[0]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it("never two requests at once: a job being handled holds the daily pass back until it is finished, and vice versa", async () => {
    let release: (r: Response) => void = () => undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    const { worker, cloud } = setup({
      fetchImpl: (url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const done = (r: Response) => {
          inFlight--;
          return r;
        };
        if (url.startsWith("https://www.mafteiach.app")) return new Promise<Response>((r) => (release = (x) => r(done(x))));
        return Promise.resolve(done(html(pageFor(new URL(url).searchParams.get("from")!))));
      },
    });
    cloud.claimLibraryJob.mockResolvedValueOnce({ jobId: "j1", kind: "library_fetch", params: { kind: "likkutei", volume: 2 } });
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!, WEEK[1]!]);
    const job = worker.tick();
    await vi.advanceTimersByTimeAsync(10);
    const daily = worker.dailyPass(); // wants its turn while the job's fetch is still open
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cloud.postDailyText).not.toHaveBeenCalled();
    release(html(likkuteiFixture));
    await job;
    await vi.advanceTimersByTimeAsync(60_000);
    await daily;
    expect(cloud.postDailyText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });
});

describe("a 403 follows the job loop's rule: one log line, a long backoff", () => {
  const forbidden = () => new CloudApiError("This agent is not allowed to fetch library pages.", "not_a_library_fetcher", 403);

  it("daily-missing 403: waits FORBIDDEN_MS, logs once however often it is asked, fetches nothing", async () => {
    const { worker, cloud, log, fetchImpl } = setup();
    cloud.getMissingDailyDates.mockRejectedValue(forbidden());
    expect(await worker.dailyPass()).toBe(FORBIDDEN_MS);
    expect(await worker.dailyPass()).toBe(FORBIDDEN_MS);
    expect(await worker.dailyPass()).toBe(FORBIDDEN_MS);
    expect(log.at("warn", "error")).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("through the timer: asks again only every 10 minutes", async () => {
    const { worker, cloud } = setup();
    cloud.getMissingDailyDates.mockRejectedValue(forbidden());
    worker.start();
    await vi.advanceTimersByTimeAsync(DAILY_STARTUP_MS + 1000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FORBIDDEN_MS - 5000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cloud.getMissingDailyDates).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it("a 403 when posting a day stops the pass (no more days), logs once, and backs off", async () => {
    const { worker, cloud, log, fetchImpl } = setup();
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!, WEEK[1]!, WEEK[2]!]);
    cloud.postDailyText.mockRejectedValue(forbidden());
    const run = worker.dailyPass();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await run).toBe(FORBIDDEN_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.at("warn", "error")).toHaveLength(1);
  });

  it("one log line is shared with the job loop: a worker already told it is forbidden does not say it twice", async () => {
    const { worker, cloud, log } = setup();
    cloud.claimLibraryJob.mockRejectedValue(forbidden());
    cloud.getMissingDailyDates.mockRejectedValue(forbidden());
    expect(await worker.tick()).toBe(FORBIDDEN_MS);
    expect(await worker.dailyPass()).toBe(FORBIDDEN_MS);
    expect(log.at("warn")).toHaveLength(1);
  });
});

describe("other errors asking the website", () => {
  it("tries again in 30 minutes, up to 4 times in a row, then waits for the next 03:30", async () => {
    const { worker, cloud } = setup();
    cloud.getMissingDailyDates.mockRejectedValue(new CloudNetworkError("offline", undefined));
    const delays: number[] = [];
    for (let i = 0; i < DAILY_MAX_ERRORS; i++) delays.push(await worker.dailyPass());
    expect(delays.slice(0, DAILY_MAX_ERRORS - 1)).toEqual(Array(DAILY_MAX_ERRORS - 1).fill(DAILY_RETRY_MS));
    expect(delays[DAILY_MAX_ERRORS - 1]).toBe(msUntilNextDailyRun(Date.now()));
  });

  it("a success clears the count", async () => {
    const { worker, cloud } = setup();
    cloud.getMissingDailyDates.mockRejectedValueOnce(new CloudNetworkError("offline", undefined));
    expect(await worker.dailyPass()).toBe(DAILY_RETRY_MS);
    expect(await worker.dailyPass()).toBe(msUntilNextDailyRun(Date.now()));
  });
});

describe("never escapes, never touches the job loop's timer", () => {
  it("a cloud that throws synchronously, and a logger that throws, never throw out of dailyPass or the timer", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const log = makeLogger();
      for (const level of ["warn", "error", "info", "debug"] as const)
        log.logger[level] = () => {
          throw new Error("log broke");
        };
      const cloud = makeCloud();
      cloud.getMissingDailyDates.mockImplementation(() => {
        throw new Error("sync boom");
      });
      const worker = createLibraryWorker({ cloud, logger: log.logger });
      worker.start();
      await vi.advanceTimersByTimeAsync(5 * 24 * 3_600_000);
      expect(cloud.getMissingDailyDates.mock.calls.length).toBeGreaterThan(2);
      await expect(worker.dailyPass()).resolves.toBeTypeOf("number");
      worker.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("stop() during a fetch: nothing is posted, no error logged, no timer left", async () => {
    const { worker, cloud, log, fetchImpl } = setup({
      fetchImpl: (_u, init) =>
        new Promise<Response>((_r, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    });
    cloud.getMissingDailyDates.mockResolvedValue([WEEK[0]!, WEEK[1]!]);
    worker.start();
    await vi.advanceTimersByTimeAsync(DAILY_STARTUP_MS + 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cloud.postDailyText).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.at("error", "warn")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the job loop keeps its own rhythm while the daily pass exists (first look 5 s after start, then every 20 s)", async () => {
    const { worker, cloud } = setup();
    worker.start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 100);
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});

describe("isolation (static)", () => {
  it("the daily code adds no import of print code or of the website to the worker", () => {
    const worker = readFileSync(join(here, "../src/library-worker.ts"), "utf8");
    const imports = [...worker.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./errors.js", "./cloud-client.js", "./logger.js", "@printio/shared/library/daily/source", "@printio/shared/library/mafteiach-fetch", "@printio/shared/library/mafteiach-parse"].sort());
  });
});
