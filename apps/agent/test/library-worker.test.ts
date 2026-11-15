import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEmbeddedHtml } from "@printio/shared/library/mafteiach-fetch";
import { parseEntryPage, parseLikkutSichos, parseListPage } from "@printio/shared/library/mafteiach-parse";
import { CloudApiError, CloudNetworkError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import { createLibraryWorker, startLibraryWorker, IDLE_MS, FORBIDDEN_MS, MAX_BACKOFF_MS, MIN_GAP_MS, LEASE_MS, type LibraryCloud } from "../src/library-worker.js";

// The parsers are the real shared ones; the mock only lets one test make the likkutei parser throw.
vi.mock("@printio/shared/library/mafteiach-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@printio/shared/library/mafteiach-parse")>();
  return { ...actual, parseLikkutSichos: vi.fn(actual.parseLikkutSichos) };
});

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "../../../packages/shared/src/library/fixtures", name), "utf8");

const HOST = "https://www.mafteiach.app";

function makeLogger() {
  const calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => void calls.push({ level, msg, fields });
  const logger: Logger = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error"), child: () => logger };
  return { logger, calls, at: (...levels: string[]) => calls.filter((c) => levels.includes(c.level)) };
}

function makeCloud() {
  const cloud = {
    claimLibraryJob: vi.fn(async (): Promise<{ jobId: string; kind: string; params: unknown } | null> => null),
    completeLibraryJob: vi.fn(async (_jobId: string, _payload: unknown): Promise<void> => undefined),
    failLibraryJob: vi.fn(async (_jobId: string, _error: string): Promise<void> => undefined),
  };
  return cloud satisfies LibraryCloud;
}

const html = (text: string, init: ResponseInit = {}) => new Response(text, { status: 200, headers: { "content-type": "text/html" }, ...init });
const job = (params: unknown, kind = "library_fetch", jobId = "job-1") => ({ jobId, kind, params });

/** A fake clock: `sleep` just moves it forward, so the 5 second gap is provable without waiting. */
function makeClock(start = 1_000_000) {
  const clock = { t: start, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    }),
  };
}

function setup(over: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  const log = makeLogger();
  const cloud = makeCloud();
  const clk = makeClock();
  const fetchImpl = vi.fn(over.fetchImpl ?? (async () => html("<html></html>")));
  const worker = createLibraryWorker({
    cloud,
    logger: log.logger,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: clk.now,
    sleep: over.sleep ?? clk.sleep,
    timeoutMs: over.timeoutMs,
  });
  return { worker, log, cloud, clk, fetchImpl };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("switched off (the default): nothing runs", () => {
  it("startLibraryWorker(enabled:false) returns null, makes no timer, no network call, and logs one debug line only", () => {
    vi.useFakeTimers();
    const log = makeLogger();
    const cloud = makeCloud();
    const fetchImpl = vi.fn();
    const w = startLibraryWorker({ enabled: false, cloud, logger: log.logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(w).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(cloud.claimLibraryJob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.level).toBe("debug");
  });

  it("enabled: it starts and schedules exactly one timer; stop() clears it", () => {
    vi.useFakeTimers();
    const log = makeLogger();
    const cloud = makeCloud();
    const w = startLibraryWorker({ enabled: true, cloud, logger: log.logger });
    expect(w).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    w!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a worker that cannot even be built never throws out of startLibraryWorker", () => {
    const log = makeLogger();
    const bad = {
      get claimLibraryJob(): never {
        throw new Error("boom");
      },
    } as unknown as LibraryCloud;
    expect(() => startLibraryWorker({ enabled: true, cloud: bad, logger: log.logger })).not.toThrow();
  });
});

describe("one claim -> fetch -> parse -> complete, per page kind", () => {
  it("Likkutei Sichos volume: fetches the rebuilt address politely, posts exactly one complete with the parsed page", async () => {
    const { worker, cloud, fetchImpl } = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 12 }));
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${HOST}/likkutei_sichos/by_volume/12`);
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toEqual({ "user-agent": "Printio/1.0 (print library browser)", accept: "text/html" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    const expected = parseLikkutSichos(decodeEmbeddedHtml(fixture("likkutei-volume.html")));
    expect(expected.parshiyos.length).toBeGreaterThan(0);
    expect(cloud.completeLibraryJob).toHaveBeenCalledWith("job-1", expected);
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
  });

  it("list page (with a year)", async () => {
    const { worker, cloud, fetchImpl } = setup({ fetchImpl: async () => html(fixture("maamorim-list.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "list", section: "maamorim", year: "5710" }));
    await worker.tick();
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${HOST}/maamorim?order=by_year&year=5710`);
    const expected = parseListPage(decodeEmbeddedHtml(fixture("maamorim-list.html")));
    expect(expected.years.length + expected.entries.length).toBeGreaterThan(0);
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.completeLibraryJob).toHaveBeenCalledWith("job-1", expected);
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
  });

  it("entry page, maamor and farbrengen shapes", async () => {
    for (const [file, path] of [
      ["maamor-entry.html", "/maamorim/123"],
      ["farbrengen-entry.html", "/all/5711-01-01"],
    ] as const) {
      const { worker, cloud, fetchImpl } = setup({ fetchImpl: async () => html(fixture(file)) });
      cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "entry", path }));
      await worker.tick();
      expect(fetchImpl.mock.calls[0]![0]).toBe(`${HOST}${path}`);
      const expected = parseEntryPage(decodeEmbeddedHtml(fixture(file)));
      expect(expected.length).toBeGreaterThan(0);
      expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
      expect(cloud.completeLibraryJob).toHaveBeenCalledWith("job-1", expected);
      expect(cloud.failLibraryJob).not.toHaveBeenCalled();
    }
  });

  it("reads a page that carries its HTML inside a script, as text", async () => {
    const wrapped = `x();\n  let html = "${fixture("maamorim-list.html").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}";\n  more();`;
    const { worker, cloud } = setup({ fetchImpl: async () => html(wrapped) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "list", section: "maamorim" }));
    await worker.tick();
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
  });
});

describe("idle", () => {
  it("claim 204 (null): nothing is fetched or posted; the next look is in about 20 s", async () => {
    const { worker, cloud, fetchImpl } = setup();
    const next = await worker.tick();
    expect(next).toBe(IDLE_MS);
    expect(IDLE_MS).toBe(20_000);
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
  });
});

describe("guards on the fetch", () => {
  it("a fetch that hangs times out and the job fails with 'could not reach the library'", async () => {
    const { worker, cloud } = setup({
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await worker.tick();
    expect(cloud.failLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "could not reach the library");
    expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
  });

  it("a body that stalls half way also times out (the time limit covers reading the body)", async () => {
    const { worker, cloud } = setup({
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("<html>"));
            init!.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await worker.tick();
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "could not reach the library");
  });

  it("a network error fails with 'could not reach the library'", async () => {
    const { worker, cloud } = setup({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await worker.tick();
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "could not reach the library");
  });

  it("404 -> 'page not found'; other errors -> a plain message with the code", async () => {
    const a = setup({ fetchImpl: async () => html("nope", { status: 404 }) });
    a.cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await a.worker.tick();
    expect(a.cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page not found");
    const b = setup({ fetchImpl: async () => html("oops", { status: 503 }) });
    b.cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await b.worker.tick();
    expect(b.cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "the library answered with an error (503)");
  });

  describe("redirects must stay on the library's own origin", () => {
    it("an off-origin redirect is never followed: one request only, job fails 'address not allowed'", async () => {
      const { worker, cloud, fetchImpl } = setup({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) });
      cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      await worker.tick();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "address not allowed");
      expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
    });

    it("look-alike and downgraded addresses are refused too", async () => {
      for (const location of ["https://www.mafteiach.app.evil.example/x", "http://www.mafteiach.app/x", "https://mafteiach.app/x", "//evil.example/x", "https://www.mafteiach.app@evil.example/x"]) {
        const { worker, cloud, fetchImpl } = setup({ fetchImpl: async () => new Response(null, { status: 301, headers: { location } }) });
        cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
        await worker.tick();
        expect(fetchImpl, location).toHaveBeenCalledTimes(1);
        expect(cloud.failLibraryJob, location).toHaveBeenCalledWith("job-1", "address not allowed");
      }
    });

    it("a fetch that already ended up somewhere else (final url off-origin) is refused", async () => {
      const { worker, cloud } = setup({
        fetchImpl: async () => {
          const res = html("<html>hello</html>");
          Object.defineProperty(res, "url", { value: "https://evil.example/landing" });
          return res;
        },
      });
      cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      await worker.tick();
      expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "address not allowed");
      expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
    });

    it("a same-origin redirect is followed (with the 5 s gap before the second request); a redirect loop gives up", async () => {
      let n = 0;
      const a = setup({
        fetchImpl: async () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: "/likkutei_sichos/by_volume/4" } }) : html(fixture("likkutei-volume.html"))),
      });
      a.cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      await a.worker.tick();
      expect(a.fetchImpl.mock.calls.map((c) => c[0])).toEqual([`${HOST}/likkutei_sichos/by_volume/3`, `${HOST}/likkutei_sichos/by_volume/4`]);
      expect(a.cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
      expect(a.clk.clock.sleeps).toEqual([MIN_GAP_MS]);

      const b = setup({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/maamorim" } }) });
      b.cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "list", section: "maamorim" }));
      await b.worker.tick();
      expect(b.fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);
      expect(b.cloud.failLibraryJob).toHaveBeenCalledTimes(1);
      expect(b.cloud.completeLibraryJob).not.toHaveBeenCalled();
    });
  });

  describe("size cap (3 MB), read from the stream with a limit", () => {
    it("a body over the cap fails 'page too large' and is not read to the end", async () => {
      let pulled = 0;
      const chunk = new Uint8Array(1024 * 1024).fill(65);
      const { worker, cloud } = setup({
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                pulled++;
                c.enqueue(chunk);
              },
            }),
            { status: 200 },
          ),
      });
      cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      await worker.tick();
      expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page too large");
      expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
      // 3 MB fits, the 4th chunk breaks the cap; a few extra pulls may be queued by the stream, but never an unbounded body.
      expect(pulled).toBeLessThanOrEqual(6);
    });

    it("a declared Content-Length over the cap is refused without reading the body", async () => {
      let pulled = 0;
      const { worker, cloud } = setup({
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                pulled++;
                c.enqueue(new Uint8Array(10));
              },
            }),
            { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } },
          ),
      });
      cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      await worker.tick();
      expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page too large");
      expect(pulled).toBeLessThanOrEqual(1);
    });

    it("a body of exactly the cap is not 'too large'", async () => {
      const exact = "a".repeat(3 * 1024 * 1024);
      const { worker, cloud } = setup({ fetchImpl: async () => html(exact) });
      cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      await worker.tick();
      // It parses to nothing, so it is the 'different' failure, not 'too large'.
      expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page looks different");
    });
  });

  it("at least 5 s between two outbound requests, measured across two jobs", async () => {
    const { worker, cloud, clk } = setup({ fetchImpl: async () => html(fixture("maamorim-list.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "list", section: "maamorim" }, "library_fetch", "j1")).mockResolvedValueOnce(job({ kind: "list", section: "all" }, "library_fetch", "j2"));
    await worker.tick();
    expect(clk.sleep).not.toHaveBeenCalled(); // the very first request waits for nobody
    clk.clock.t += 1000; // one second later the next job arrives
    await worker.tick();
    expect(clk.clock.sleeps).toEqual([MIN_GAP_MS - 1000]);
    expect(MIN_GAP_MS).toBe(5000);
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(2);
  });

  it("no wait when the gap has already passed", async () => {
    const { worker, cloud, clk } = setup({ fetchImpl: async () => html(fixture("maamorim-list.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "list", section: "maamorim" })).mockResolvedValueOnce(job({ kind: "list", section: "all" }, "library_fetch", "j2"));
    await worker.tick();
    clk.clock.t += MIN_GAP_MS + 1;
    await worker.tick();
    expect(clk.sleep).not.toHaveBeenCalled();
  });

  it("the gap also applies after a failed request", async () => {
    const { worker, cloud, clk } = setup({
      fetchImpl: async () => {
        throw new TypeError("down");
      },
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 1 })).mockResolvedValueOnce(job({ kind: "likkutei", volume: 2 }, "library_fetch", "j2"));
    await worker.tick();
    await worker.tick();
    expect(clk.clock.sleeps).toEqual([MIN_GAP_MS]);
  });
});

describe("the web address is rebuilt from params, never taken from the cloud", () => {
  it.each([
    ["an address instead of a path", { kind: "entry", path: "https://evil.example/maamorim/1" }],
    ["a path that is not an allowed shape", { kind: "entry", path: "/admin/secrets" }],
    ["a protocol-relative path", { kind: "entry", path: "//evil.example/x" }],
    ["a volume that is not a number", { kind: "likkutei", volume: "12" }],
    ["a volume out of range", { kind: "likkutei", volume: 500 }],
    ["an unknown section", { kind: "list", section: "../etc" }],
    ["a bad year", { kind: "list", section: "all", year: "5711/../x" }],
    ["an unknown page kind", { kind: "home" }],
    ["no params at all", undefined],
    ["null params", null],
    ["a bare string", "https://evil.example/"],
  ])("%s -> job fails 'address not allowed' and NOTHING is fetched", async (_label, params) => {
    const { worker, cloud, fetchImpl } = setup();
    cloud.claimLibraryJob.mockResolvedValueOnce(job(params));
    await worker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cloud.failLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "address not allowed");
    expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
  });

  it("an address smuggled in beside good params (url, key, host) is ignored: only the rebuilt address is fetched", async () => {
    const { worker, cloud, fetchImpl } = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 7, url: "https://evil.example/x", sourceUrl: "https://evil.example/y", host: "evil.example" }));
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${HOST}/likkutei_sichos/by_volume/7`);
  });

  it("an unknown job kind fails with a short reason and moves on (no fetch)", async () => {
    const { worker, cloud, fetchImpl } = setup();
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 1 }, "daily_fetch"));
    const next = await worker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "unsupported job type");
    expect(next).toBeLessThan(IDLE_MS); // more may be waiting: look again soon
  });
});

describe("the page looks different", () => {
  it("a parser that throws -> 'page looks different'", async () => {
    const { parseLikkutSichos: mocked } = await import("@printio/shared/library/mafteiach-parse");
    vi.mocked(mocked).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { worker, cloud } = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await worker.tick();
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page looks different");
    expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
  });

  it("an empty volume or an empty list (the website's own emptiness rule) -> 'page looks different'", async () => {
    for (const p of [
      { kind: "likkutei", volume: 3 },
      { kind: "list", section: "all" },
    ]) {
      const { worker, cloud } = setup({ fetchImpl: async () => html("<html><body><p>Sorry, nothing here</p></body></html>") });
      cloud.claimLibraryJob.mockResolvedValueOnce(job(p));
      await worker.tick();
      expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page looks different");
      expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
    }
  });

  it("an empty body -> 'page looks different'", async () => {
    const { worker, cloud } = setup({ fetchImpl: async () => new Response(null, { status: 200 }) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await worker.tick();
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page looks different");
  });
});

describe("talking to the website: backoff and refusals", () => {
  it("claim 403: ONE clear log line, then only about every 10 minutes; a later success starts over", async () => {
    const { worker, cloud, log } = setup();
    cloud.claimLibraryJob.mockRejectedValue(new CloudApiError("not allowed", "not_a_library_fetcher", 403));
    expect(await worker.tick()).toBe(FORBIDDEN_MS);
    expect(await worker.tick()).toBe(FORBIDDEN_MS);
    expect(await worker.tick()).toBe(FORBIDDEN_MS);
    expect(FORBIDDEN_MS).toBe(10 * 60_000);
    expect(log.at("warn", "error")).toHaveLength(1);
    expect(log.at("warn", "error")[0]!.msg).toMatch(/not allowed to fetch library pages/);
    cloud.claimLibraryJob.mockReset();
    cloud.claimLibraryJob.mockResolvedValueOnce(null).mockRejectedValueOnce(new CloudApiError("not allowed", "not_a_library_fetcher", 403));
    expect(await worker.tick()).toBe(IDLE_MS);
    expect(await worker.tick()).toBe(FORBIDDEN_MS);
    expect(log.at("warn", "error")).toHaveLength(2);
  });

  it("other errors back off exponentially (20 s, 40 s ... capped at 5 minutes) and a success resets it", async () => {
    const { worker, cloud } = setup();
    cloud.claimLibraryJob.mockRejectedValue(new CloudNetworkError("offline"));
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(await worker.tick());
    expect(delays).toEqual([20_000, 40_000, 80_000, 160_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(MAX_BACKOFF_MS).toBe(5 * 60_000);
    cloud.claimLibraryJob.mockReset();
    cloud.claimLibraryJob.mockResolvedValueOnce(null).mockRejectedValueOnce(new CloudApiError("down", "HTTP_502", 502));
    expect(await worker.tick()).toBe(IDLE_MS);
    expect(await worker.tick()).toBe(20_000);
  });

  it("a network outage never throws out of tick(), even for a non-Error rejection or a logger that throws", async () => {
    const { worker, cloud, log } = setup();
    log.logger.warn = () => {
      throw new Error("log broke");
    };
    log.logger.error = () => {
      throw new Error("log broke");
    };
    cloud.claimLibraryJob.mockRejectedValue("a bare string");
    await expect(worker.tick()).resolves.toBeGreaterThan(0);
  });

  it("complete answers 400: logged once, NOT retried, and the job is failed once so it cannot come back forever", async () => {
    const { worker, cloud, log } = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    cloud.completeLibraryJob.mockRejectedValue(new CloudApiError("bad payload", "payload_invalid", 400));
    const next = await worker.tick();
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page looks different");
    expect(log.at("warn")).toHaveLength(1);
    expect(next).toBeLessThan(IDLE_MS); // not a backoff: the website said no, the cloud is fine
    // a later tick with an empty queue does not post again
    await worker.tick();
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
  });

  it("complete answers 413 -> fail 'page too large'; 403/409 (lease lost / already finished) -> only a log line", async () => {
    const a = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
    a.cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    a.cloud.completeLibraryJob.mockRejectedValue(new CloudApiError("big", "too_large", 413));
    await a.worker.tick();
    expect(a.cloud.failLibraryJob).toHaveBeenCalledWith("job-1", "page too large");
    for (const status of [403, 409]) {
      const b = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
      b.cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
      b.cloud.completeLibraryJob.mockRejectedValue(new CloudApiError("no", "no_lease", status));
      await b.worker.tick();
      expect(b.cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
      expect(b.cloud.failLibraryJob).not.toHaveBeenCalled();
      expect(b.log.at("warn")).toHaveLength(1);
    }
  });

  it("complete cannot reach the website (network / 5xx): not retried here, the lease runs out and the website reclaims it; the worker backs off", async () => {
    const { worker, cloud } = setup({ fetchImpl: async () => html(fixture("likkutei-volume.html")) });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    cloud.completeLibraryJob.mockRejectedValue(new CloudNetworkError("offline"));
    const next = await worker.tick();
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
    expect(next).toBe(20_000);
  });

  it("fail answers 4xx: logged once, not retried, nothing thrown", async () => {
    const { worker, cloud, log } = setup();
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 1 }, "other"));
    cloud.failLibraryJob.mockRejectedValue(new CloudApiError("gone", "wrong_state", 409));
    await expect(worker.tick()).resolves.toBeGreaterThan(0);
    expect(cloud.failLibraryJob).toHaveBeenCalledTimes(1);
    expect(log.at("warn")).toHaveLength(1);
  });

  it("a job not finished within its 120 s lease is abandoned: nothing is posted", async () => {
    expect(LEASE_MS).toBe(120_000);
    const clk = makeClock();
    const log = makeLogger();
    const cloud = makeCloud();
    const worker = createLibraryWorker({
      cloud,
      logger: log.logger,
      now: clk.now,
      sleep: clk.sleep,
      fetchImpl: (async () => {
        clk.clock.t += 121_000;
        return html(fixture("likkutei-volume.html"));
      }) as unknown as typeof fetch,
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    await worker.tick();
    expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
  });
});

describe("concurrency, stopping, and never escaping", () => {
  it("concurrency is exactly 1: a second tick while one is running does nothing", async () => {
    let release: (r: Response) => void = () => undefined;
    const { worker, cloud } = setup({ fetchImpl: () => new Promise<Response>((r) => (release = r)) });
    cloud.claimLibraryJob.mockResolvedValue(job({ kind: "likkutei", volume: 3 }));
    const first = worker.tick();
    await vi.waitFor(() => expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(1));
    await worker.tick();
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(1);
    release(html(fixture("likkutei-volume.html")));
    await first;
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
  });

  it("stop() during a fetch ends cleanly: the fetch is aborted, nothing is posted, no error logged, no timer left", async () => {
    const aborted = vi.fn();
    const { worker, cloud, log, fetchImpl } = setup({
      fetchImpl: (_u, init) =>
        new Promise<Response>((_r, rej) =>
          init!.signal!.addEventListener("abort", () => {
            aborted();
            rej(new DOMException("aborted", "AbortError"));
          }),
        ),
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "likkutei", volume: 3 }));
    const run = worker.tick();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    worker.stop();
    await run;
    expect(aborted).toHaveBeenCalled();
    expect(cloud.completeLibraryJob).not.toHaveBeenCalled();
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
    expect(log.at("error", "warn")).toHaveLength(0);
  });

  it("stop() while waiting out the 5 s gap also ends cleanly, with no second request made", async () => {
    const waiting = vi.fn();
    const { worker, cloud, fetchImpl } = setup({
      fetchImpl: async () => html(fixture("maamorim-list.html")),
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          waiting();
          signal.addEventListener("abort", () => resolve());
        }),
    });
    cloud.claimLibraryJob.mockResolvedValueOnce(job({ kind: "list", section: "maamorim" })).mockResolvedValueOnce(job({ kind: "list", section: "all" }, "library_fetch", "j2"));
    await worker.tick(); // first request, no wait
    const second = worker.tick();
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
    worker.stop();
    await second;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cloud.completeLibraryJob).toHaveBeenCalledTimes(1);
    expect(cloud.failLibraryJob).not.toHaveBeenCalled();
  });

  it("after stop(), tick() does nothing", async () => {
    const { worker, cloud } = setup();
    worker.stop();
    await worker.tick();
    expect(cloud.claimLibraryJob).not.toHaveBeenCalled();
  });

  it("the timer loop: first look soon, then about every 20 s, and stop() ends it for good", async () => {
    vi.useFakeTimers();
    const log = makeLogger();
    const cloud = makeCloud();
    const worker = createLibraryWorker({ cloud, logger: log.logger });
    worker.start();
    worker.start(); // a second start is a no-op
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(2);
    worker.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cloud.claimLibraryJob).toHaveBeenCalledTimes(2);
  });

  it("its timer never keeps the process alive (unref)", () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSetTimeout(fn, ms);
      return Object.assign(t, {
        unref: () => {
          unref();
          return t;
        },
      });
    }) as unknown as typeof setTimeout);
    const worker = createLibraryWorker({ cloud: makeCloud(), logger: makeLogger().logger });
    worker.start();
    worker.stop();
    expect(unref).toHaveBeenCalled();
  });

  it("nothing escapes: a throwing cloud client and a throwing logger inside the timer loop cause no unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const log = makeLogger();
      for (const level of ["warn", "error", "info", "debug"] as const) {
        log.logger[level] = () => {
          throw new Error("log broke");
        };
      }
      const cloud = makeCloud();
      cloud.claimLibraryJob.mockImplementation(() => {
        throw new Error("sync boom");
      });
      const worker = createLibraryWorker({ cloud, logger: log.logger });
      worker.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(cloud.claimLibraryJob.mock.calls.length).toBeGreaterThan(1);
      worker.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("isolation from the print loop (static)", () => {
  it("no print/heartbeat/command/self-update module imports the library worker, and the worker imports none of them", () => {
    const src = (f: string) => readFileSync(join(here, "../src", f), "utf8");
    for (const f of ["orchestrator.ts", "health-monitor.ts", "commands.ts", "self-update.ts", "print-executor.ts", "raw-print-executor.ts", "job-queue.ts", "cloud-client.ts"]) {
      expect(src(f), f).not.toMatch(/library-worker/);
    }
    const worker = src("library-worker.ts");
    for (const m of ["orchestrator", "health-monitor", "commands", "self-update", "print-executor", "job-queue", "printer-manager", "spooler-monitor"]) {
      expect(worker, m).not.toMatch(new RegExp(`from "\\./${m}\\.js"`));
    }
    expect(worker).not.toMatch(/apps\/web|@\/lib/);
  });
});
