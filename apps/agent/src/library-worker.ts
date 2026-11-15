/**
 * The optional library worker (docs/PHASE-C-PLAN.md, C1c). OFF by default; meant only for the owner's own print server.
 *
 * What it does: about every 20 s it asks the website for a "fetch this library page" job (POST server-jobs/claim), rebuilds the
 * page address ITSELF from the job's structured params with the shared allow-list (`libraryPageUrl`), fetches that one page from
 * the library politely, parses it with the shared parsers and posts the parsed result back (`complete`) or a short reason
 * (`fail`). It never uses an address the cloud sends, and it never looks at anything but the one allowed library site.
 *
 * ISOLATION from the print loop is the whole point of this file's shape:
 *  - it has its OWN timer and its own state, and imports nothing from the orchestrator, health monitor, command or print code;
 *  - it is never awaited by, and shares no timer with, any other loop (the entry point starts it and forgets it);
 *  - concurrency is exactly 1 (a run is never started while one is running);
 *  - EVERY entry point (`tick`, the timer callback, `start`, `stop`, `startLibraryWorker`) catches everything, logs through the
 *    agent's logger (itself guarded: a throwing logger cannot escape either) and swallows it, so no exception and no
 *    unhandled promise rejection can reach a caller;
 *  - its timer is `unref`'d, so it can never keep the process alive;
 *  - it talks to the cloud through the existing CloudClient, using methods that do NOT feed `consecutiveAuthFailures` (which
 *    slows the print loop down), so a 403 here can never slow printing.
 *
 * C1d adds a second job to the same worker (same switch, same rules): once a night, about 03:30 local time (and once about 2 minutes
 * after start if it has not run that day), it asks the website which of the next 7 days have no daily study text yet, fetches each
 * missing day from the daily study source (address rebuilt with the shared `shiurUrl`, same origin check, size cap, time limit and
 * 5 s gap as the library pages), parses it with the shared `parseShiurPage` and posts it (`daily`). It has its OWN timer; the
 * requests it makes share the 5 s gap and the one-at-a-time rule with the job loop, so the two never fetch at once.
 */

import { decodeEmbeddedHtml, HOST, libraryPageUrl, MAX_PAGE_BYTES, TIMEOUT_MS, type PageRef } from "@printio/shared/library/mafteiach-fetch";
import { parseEntryPage, parseLikkutSichos, parseListPage } from "@printio/shared/library/mafteiach-parse";
import { parseShiurPage, shiurUrl, SHIUR_ORIGIN } from "@printio/shared/library/daily/source";
import { CloudApiError } from "./errors.js";
import type { LibraryJobEnvelope } from "./cloud-client.js";
import type { Logger } from "./logger.js";

/** Look for a job this often while idle. */
export const IDLE_MS = 20_000;
/** First look after start (the print loop gets going first). */
export const INITIAL_DELAY_MS = 5_000;
/** After a finished job, look again after this short pause (more may be waiting, but never a tight loop). */
export const AFTER_JOB_MS = 1_000;
/** Backoff after an error talking to the cloud: starts at the idle interval, doubles, never more than this. */
export const MAX_BACKOFF_MS = 5 * 60_000;
/** This server is not allowed to fetch (403 on claim): ask again only this rarely. */
export const FORBIDDEN_MS = 10 * 60_000;
/** At least this long between the end of one request to the library and the start of the next (global, across jobs). */
export const MIN_GAP_MS = 5_000;
/** The website lease on a claimed job; past this the job is abandoned (the website hands it out again). */
export const LEASE_MS = 120_000;
/** Same-origin redirects followed per page (each one is a request with its own gap). */
const MAX_REDIRECTS = 3;

/** The daily week-ahead fetch: wakes at this local time every night (24-hour clock). */
export const DAILY_HOUR = 3;
export const DAILY_MINUTE = 30;
/** After start, one look at the week ahead this long after the worker starts (when it has not run that day yet). */
export const DAILY_STARTUP_MS = 2 * 60_000;
/** How many days from today the nightly fetch covers. */
export const DAILY_DAYS = 7;
/** A failed attempt to ask the website is repeated this much later, at most DAILY_MAX_ERRORS times in a row, then it waits for the next night. */
export const DAILY_RETRY_MS = 30 * 60_000;
export const DAILY_MAX_ERRORS = 4;

const USER_AGENT = "Printio/1.0 (print library browser)";
const DAILY_USER_AGENT = "Printio/1.0 (daily study booklet)";
const LIBRARY_ORIGIN = new URL(HOST).origin;
const DAILY_ORIGIN = new URL(SHIUR_ORIGIN).origin;

/**
 * The calls the worker makes to the cloud: the CloudClient provides them (tests pass a fake). The two daily calls are optional:
 * without them the nightly week-ahead fetch is simply not created.
 */
export interface LibraryCloud {
  claimLibraryJob(): Promise<LibraryJobEnvelope | null>;
  completeLibraryJob(jobId: string, payload: unknown): Promise<void>;
  failLibraryJob(jobId: string, error: string): Promise<void>;
  /** Which of the `days` days from `from` (YYYY-MM-DD) have no saved daily text at all. */
  getMissingDailyDates?(from: string, days: number): Promise<string[]>;
  /** Hand one parsed day to the website (`{ date, day }`; the website builds the source address itself). */
  postDailyText?(date: string, day: unknown): Promise<void>;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** The local calendar date (the worker's own computer) as YYYY-MM-DD. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** Milliseconds from `ms` until the next 03:30 local time (a full day when it is exactly 03:30 now). */
export function msUntilNextDailyRun(ms: number): number {
  const d = new Date(ms);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAILY_HOUR, DAILY_MINUTE, 0, 0);
  if (next.getTime() <= ms) next.setDate(next.getDate() + 1);
  return next.getTime() - ms;
}

export interface LibraryWorkerDeps {
  cloud: LibraryCloud;
  logger: Logger;
  /** Injected in tests; defaults to Node's global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Waits `ms` (resolving early when the signal aborts). Injected in tests so the 5 s gap needs no real waiting. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Per-request time limit (headers and body together). Defaults to the shared 15 s. */
  timeoutMs?: number;
}

export interface LibraryWorker {
  /** One pass of the week-ahead daily fetch (what the nightly timer does). Resolves to the delay (ms) before the next try. Never throws. */
  dailyPass(): Promise<number>;
  /** Starts the timer loop (a no-op when already started or stopped). Never throws. */
  start(): void;
  /** Stops the loop and aborts anything in flight. Never throws. */
  stop(): void;
  /** One look for a job and, if there is one, its whole handling. Resolves to the delay (ms) before the next look. Never throws. */
  tick(): Promise<number>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The page a job's params name, built from ONLY the validated fields (extras such as a "url" are ignored), or null. */
function refFromParams(input: unknown): PageRef | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  let ref: PageRef | null = null;
  if (r.kind === "likkutei") {
    if (typeof r.volume === "number") ref = { kind: "likkutei", volume: r.volume };
  } else if (r.kind === "list") {
    if (r.section === "maamorim" || r.section === "all") {
      if (r.year === undefined) ref = { kind: "list", section: r.section };
      else if (typeof r.year === "string") ref = { kind: "list", section: r.section, year: r.year };
    }
  } else if (r.kind === "entry") {
    if (typeof r.path === "string") ref = { kind: "entry", path: r.path };
  }
  // The shared builder is the one judge of the allowed shapes.
  return ref && libraryPageUrl(ref) !== null ? ref : null;
}

type PageResult = { ok: true; text: string } | { ok: false; reason: string } | { stopped: true };
type JobOutcome = "ok" | "cloud_error" | "abandoned";

const REASON = {
  unreachable: "could not reach the library",
  notFound: "page not found",
  tooLarge: "page too large",
  different: "page looks different",
  notAllowed: "address not allowed",
  unsupported: "unsupported job type",
} as const;

export function createLibraryWorker(deps: LibraryWorkerDeps): LibraryWorker {
  const { cloud, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  let started = false;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopController = new AbortController();
  /** When the last request to the library ended (the global gap is measured from here). */
  let lastRequestEnd: number | null = null;
  let consecutiveErrors = 0;
  let forbiddenLogged = false;
  // The daily week-ahead fetch: its own timer and in-memory state (nothing is stored).
  let dailyTimer: ReturnType<typeof setTimeout> | undefined;
  let dailyRunning = false;
  let lastDailyDay: string | null = null;
  let dailyErrors = 0;

  /** A logger that can never throw into the worker. */
  const log = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void => {
    try {
      logger[level](msg, fields);
    } catch {
      /* a broken logger must not become a crash */
    }
  };

  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const backoffMs = (n: number): number => Math.min(IDLE_MS * 2 ** (Math.max(1, n) - 1), MAX_BACKOFF_MS);

  async function waitForGap(): Promise<void> {
    if (lastRequestEnd === null) return;
    const wait = lastRequestEnd + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait, stopController.signal);
  }

  /** Reads a response body as text, never holding more than MAX_PAGE_BYTES: past the cap it stops reading and drops the rest. */
  async function readCapped(res: Response, controller: AbortController): Promise<{ text: string } | { tooLarge: true }> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
      controller.abort();
      return { tooLarge: true };
    }
    if (!res.body) return { text: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) {
        controller.abort();
        void reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks)) };
  }

  /** Fetches one page. Every address (the first and each redirect) must be on the given site's own origin (the library's unless said otherwise). */
  async function fetchPage(firstUrl: string, site: { origin: string; userAgent: string } = { origin: LIBRARY_ORIGIN, userAgent: USER_AGENT }): Promise<PageResult> {
    let current = firstUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return { ok: false, reason: REASON.notAllowed };
      }
      if (parsed.origin !== site.origin || parsed.username || parsed.password) return { ok: false, reason: REASON.notAllowed };

      await waitForGap();
      if (stopped) return { stopped: true };

      const controller = new AbortController();
      const onStop = () => controller.abort();
      stopController.signal.addEventListener("abort", onStop, { once: true });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(current, {
          headers: { "user-agent": site.userAgent, accept: "text/html" },
          redirect: "manual",
          signal: controller.signal,
        });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          void res.body?.cancel().catch(() => undefined);
          const location = res.headers.get("location");
          if (!location) return { ok: false, reason: REASON.notAllowed };
          try {
            current = new URL(location, current).href;
          } catch {
            return { ok: false, reason: REASON.notAllowed };
          }
          continue; // the next loop turn checks the origin BEFORE any request is made to it
        }

        // Belt and braces: whatever answered must still be the library itself (a fetch that followed a redirect on its own).
        if (res.url) {
          let finalOrigin = "";
          try {
            finalOrigin = new URL(res.url).origin;
          } catch {
            /* treated as off-origin below */
          }
          if (finalOrigin !== site.origin) {
            void res.body?.cancel().catch(() => undefined);
            return { ok: false, reason: REASON.notAllowed };
          }
        }
        if (res.status === 404) {
          void res.body?.cancel().catch(() => undefined);
          return { ok: false, reason: REASON.notFound };
        }
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          return { ok: false, reason: `the library answered with an error (${res.status})` };
        }
        const body = await readCapped(res, controller);
        if ("tooLarge" in body) return { ok: false, reason: REASON.tooLarge };
        return { ok: true, text: body.text };
      } catch (err) {
        if (stopped) return { stopped: true };
        log("debug", "library fetch failed", { error: errText(err) });
        return { ok: false, reason: REASON.unreachable };
      } finally {
        clearTimeout(timeout);
        stopController.signal.removeEventListener("abort", onStop);
        lastRequestEnd = now();
      }
    }
    return { ok: false, reason: REASON.unreachable }; // too many redirects
  }

  /** The parsed page for the job's kind, or null when the page parses to nothing (the website's own emptiness rules). */
  function parsePage(ref: PageRef, text: string): unknown | null {
    try {
      const htmlText = decodeEmbeddedHtml(text);
      if (ref.kind === "likkutei") {
        const page = parseLikkutSichos(htmlText);
        return page.parshiyos.length > 0 ? page : null;
      }
      if (ref.kind === "list") {
        const page = parseListPage(htmlText);
        return page.years.length > 0 || page.entries.length > 0 ? page : null;
      }
      return parseEntryPage(htmlText);
    } catch (err) {
      log("warn", "library page could not be parsed", { error: errText(err) });
      return null;
    }
  }

  /** Posts `fail`. A 4xx (the job is no longer ours) is logged once and dropped; a network error / 5xx counts as a cloud error. */
  async function postFail(jobId: string, reason: string): Promise<JobOutcome> {
    try {
      await cloud.failLibraryJob(jobId, reason);
      log("info", "library job failed", { jobId, reason });
      return "ok";
    } catch (err) {
      if (err instanceof CloudApiError && err.status >= 400 && err.status < 500) {
        log("warn", "the website refused the failure report - not retrying", { jobId, status: err.status, code: err.code });
        return "ok";
      }
      log("warn", "could not report a library job failure", { jobId, error: errText(err) });
      return "cloud_error";
    }
  }

  async function postComplete(jobId: string, payload: unknown): Promise<JobOutcome> {
    try {
      await cloud.completeLibraryJob(jobId, payload);
      log("info", "library job done", { jobId });
      return "ok";
    } catch (err) {
      if (err instanceof CloudApiError && err.status >= 400 && err.status < 500) {
        log("warn", "the website refused the fetched page - not retrying", { jobId, status: err.status, code: err.code });
        // The page itself was refused (invalid / empty / too big): close the job so it cannot come back every two minutes.
        // 403/404/409 mean the job is no longer ours (lease lost or already finished): nothing more to say about it.
        if (err.status === 400) return postFail(jobId, REASON.different);
        if (err.status === 413) return postFail(jobId, REASON.tooLarge);
        return "ok";
      }
      log("warn", "could not deliver a fetched library page - the website will hand the job out again", { jobId, error: errText(err) });
      return "cloud_error";
    }
  }

  async function handleJob(job: LibraryJobEnvelope): Promise<JobOutcome> {
    const claimedAt = now();
    const { jobId } = job;
    if (job.kind !== "library_fetch") return postFail(jobId, REASON.unsupported);

    const ref = refFromParams(job.params);
    const url = ref ? libraryPageUrl(ref) : null;
    if (!ref || !url) return postFail(jobId, REASON.notAllowed); // nothing is fetched

    const page = await fetchPage(url);
    if ("stopped" in page) return "abandoned";
    if (now() - claimedAt >= LEASE_MS) {
      log("warn", "library job took longer than its lease - abandoned (the website hands it out again)", { jobId });
      return "abandoned";
    }
    if (!page.ok) return postFail(jobId, page.reason);

    const payload = parsePage(ref, page.text);
    if (payload === null) return postFail(jobId, REASON.different);
    if (stopped) return "abandoned";
    return postComplete(jobId, payload);
  }

  async function tickInner(): Promise<number> {
    let job: LibraryJobEnvelope | null;
    try {
      job = await cloud.claimLibraryJob();
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 403) {
        if (!forbiddenLogged) {
          forbiddenLogged = true;
          log("warn", "this print server is not allowed to fetch library pages (not listed in library_fetchers) - the library worker will only check again every ~10 minutes", { code: err.code });
        }
        return FORBIDDEN_MS;
      }
      consecutiveErrors += 1;
      const delay = backoffMs(consecutiveErrors);
      log("warn", "library worker could not ask the website for a job - backing off", { error: errText(err), nextTryMs: delay });
      return delay;
    }
    consecutiveErrors = 0;
    forbiddenLogged = false;
    if (!job) return IDLE_MS;

    const outcome = await handleJob(job);
    if (outcome === "cloud_error") {
      consecutiveErrors += 1;
      return backoffMs(consecutiveErrors);
    }
    return AFTER_JOB_MS;
  }

  async function tick(): Promise<number> {
    if (stopped || running) return IDLE_MS;
    running = true;
    try {
      return await tickInner();
    } catch (err) {
      log("error", "unexpected library worker error", { error: errText(err) });
      consecutiveErrors += 1;
      return backoffMs(consecutiveErrors);
    } finally {
      running = false;
    }
  }

  /** Waits for the job loop to be idle, then takes the one-at-a-time slot. False when the worker was stopped (or never got a turn). */
  async function takeTurn(): Promise<boolean> {
    for (let i = 0; i < 600 && !stopped; i++) {
      if (!running) {
        running = true;
        return true;
      }
      await sleep(1_000, stopController.signal);
    }
    return false;
  }

  const isIsoDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const addDaysLocal = (key: string, n: number): string => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number];
    return localDateKey(new Date(y, m - 1, d + n, 12).getTime());
  };

  type DayOutcome = "saved" | "skipped" | "forbidden" | "cloud_error" | "stopped";

  /** One missing day: fetch from the source, parse, check, post. Every unfetchable or unparseable day is skipped with ONE log line. */
  async function fetchAndPostDay(date: string): Promise<DayOutcome> {
    const skip = (reason: string): DayOutcome => {
      log("info", "daily study text: day skipped", { date, reason });
      return "skipped";
    };
    let url: string;
    try {
      url = shiurUrl(date); // the address is always rebuilt here from the date; nothing from the cloud is used as an address
    } catch {
      return skip(REASON.notAllowed);
    }
    const page = await fetchPage(url, { origin: DAILY_ORIGIN, userAgent: DAILY_USER_AGENT });
    if ("stopped" in page) return "stopped";
    if (!page.ok) return skip(page.reason);
    let day: ReturnType<typeof parseShiurPage> = null;
    try {
      day = parseShiurPage(page.text);
    } catch (err) {
      log("debug", "daily study page could not be parsed", { error: errText(err) });
    }
    if (!day) return skip(REASON.different);
    if (day.date !== date) return skip("page is for another day");
    if (stopped) return "stopped";
    try {
      await cloud.postDailyText!(date, day);
      log("info", "daily study text saved", { date, studies: day.studies.length });
      return "saved";
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 403) return "forbidden";
      if (err instanceof CloudApiError && err.status >= 400 && err.status < 500) {
        log("warn", "the website refused a daily study day - skipped", { date, status: err.status, code: err.code });
        return "skipped";
      }
      log("warn", "could not deliver a daily study day to the website", { date, error: errText(err) });
      return "cloud_error";
    }
  }

  const logForbiddenOnce = (err: unknown): void => {
    if (forbiddenLogged) return;
    forbiddenLogged = true;
    log("warn", "this print server is not allowed to fetch library pages (not listed in library_fetchers) - the library worker will only check again every ~10 minutes", { code: err instanceof CloudApiError ? err.code : undefined });
  };

  /** After a failed attempt: try again soon a few times, then wait for the next night. */
  function dailyRetryDelay(): number {
    dailyErrors += 1;
    if (dailyErrors >= DAILY_MAX_ERRORS) {
      dailyErrors = 0;
      return msUntilNextDailyRun(now());
    }
    return DAILY_RETRY_MS;
  }

  async function dailyPassInner(): Promise<number> {
    const nightly = () => msUntilNextDailyRun(now());
    if (stopped || !cloud.getMissingDailyDates || !cloud.postDailyText) return nightly();
    const today = localDateKey(now());
    if (lastDailyDay === today) return nightly(); // already done today (the startup look and the 03:30 look never both run)

    let missing: string[];
    try {
      missing = await cloud.getMissingDailyDates(today, DAILY_DAYS);
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 403) {
        logForbiddenOnce(err);
        return FORBIDDEN_MS;
      }
      log("warn", "daily study text: could not ask the website which days are missing", { error: errText(err) });
      return dailyRetryDelay();
    }
    forbiddenLogged = false;
    dailyErrors = 0;
    lastDailyDay = today;

    // Only what lies in the next 7 days is ever fetched, whatever the website said, oldest first, each date once.
    const window = new Set(Array.from({ length: DAILY_DAYS }, (_, i) => addDaysLocal(today, i)));
    const dates = [...new Set(missing.filter(isIsoDate).filter((d) => window.has(d)))].sort();
    if (dates.length === 0) {
      log("debug", "daily study text: nothing missing for the next week");
      return nightly();
    }

    for (const date of dates) {
      if (!(await takeTurn())) return nightly();
      let outcome: DayOutcome;
      try {
        outcome = await fetchAndPostDay(date);
      } finally {
        running = false;
      }
      if (outcome === "stopped") return nightly();
      if (outcome === "forbidden") {
        logForbiddenOnce(new CloudApiError("forbidden", "not_a_library_fetcher", 403));
        lastDailyDay = null;
        return FORBIDDEN_MS;
      }
      if (outcome === "cloud_error") {
        lastDailyDay = null; // not finished: look again soon
        return dailyRetryDelay();
      }
    }
    return nightly();
  }

  async function dailyPass(): Promise<number> {
    if (stopped || dailyRunning) return DAILY_RETRY_MS;
    dailyRunning = true;
    try {
      return await dailyPassInner();
    } catch (err) {
      log("error", "unexpected error in the daily study fetch", { error: errText(err) });
      return dailyRetryDelay();
    } finally {
      dailyRunning = false;
    }
  }

  function scheduleDaily(ms: number): void {
    if (stopped || !cloud.getMissingDailyDates || !cloud.postDailyText) return;
    try {
      dailyTimer = setTimeout(() => {
        dailyTimer = undefined;
        void (async () => {
          let next = DAILY_RETRY_MS;
          try {
            next = await dailyPass();
          } catch {
            next = DAILY_RETRY_MS;
          }
          scheduleDaily(next);
        })().catch(() => undefined);
      }, ms);
      (dailyTimer as { unref?: () => void }).unref?.();
    } catch (err) {
      log("error", "daily study timer could not be set - the nightly fetch stays stopped", { error: errText(err) });
    }
  }

  function schedule(ms: number): void {
    if (stopped) return;
    try {
      timer = setTimeout(() => {
        timer = undefined;
        // The callback is async work in a timer: it can only ever end by scheduling the next look. Nothing escapes it.
        void (async () => {
          let next = IDLE_MS;
          try {
            next = await tick();
          } catch {
            next = MAX_BACKOFF_MS;
          }
          schedule(next);
        })().catch(() => undefined);
      }, ms);
      (timer as { unref?: () => void }).unref?.();
    } catch (err) {
      log("error", "library worker could not schedule its next look - it stays stopped", { error: errText(err) });
    }
  }

  return {
    start() {
      try {
        if (started || stopped) return;
        started = true;
        schedule(INITIAL_DELAY_MS);
        scheduleDaily(DAILY_STARTUP_MS);
      } catch (err) {
        log("error", "library worker failed to start", { error: errText(err) });
      }
    },
    stop() {
      try {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (dailyTimer) clearTimeout(dailyTimer);
        dailyTimer = undefined;
        stopController.abort();
      } catch (err) {
        log("error", "library worker failed to stop cleanly", { error: errText(err) });
      }
    },
    tick,
    dailyPass,
  };
}

export interface StartLibraryWorkerOptions extends LibraryWorkerDeps {
  /** `config.libraryWorker` (PRINTIO_LIBRARY_WORKER is 1 or true). */
  enabled: boolean;
}

/**
 * The one entry point the agent's `start` command calls. Off: nothing is created (no timer, no network call) and one debug
 * line is logged. On: the loop is started and the handle returned so shutdown can stop it. Never throws; a failure to build
 * or start it just means "no library worker" (null), never a failed agent start.
 */
export function startLibraryWorker(opts: StartLibraryWorkerOptions): LibraryWorker | null {
  const { enabled, ...deps } = opts;
  if (!enabled) {
    try {
      deps.logger.debug("library worker is off (set PRINTIO_LIBRARY_WORKER=1 to turn it on)");
    } catch {
      /* ignore */
    }
    return null;
  }
  try {
    const worker = createLibraryWorker(deps);
    worker.start();
    try {
      deps.logger.info("library worker started (fetches library pages for the website's shared cache)");
    } catch {
      /* ignore */
    }
    return worker;
  } catch (err) {
    try {
      deps.logger.error("library worker could not be started - continuing without it", { error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* ignore */
    }
    return null;
  }
}
