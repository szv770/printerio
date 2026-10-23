import { describe, expect, it } from "vitest";
import {
  WAITING_BACKOFF_MS,
  WAITING_UNAVAILABLE_TEXT,
  WAITING_UNKNOWN_TEXT,
  DEFAULT_WAITING_WINDOW_MS,
  waitingBackoffMs,
  formatWaitingMarker,
  parseWaitingMarker,
  planRelease,
  gaveUpMessage,
  parseGaveUp,
} from "./waiting";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");

describe("waitingBackoffMs", () => {
  it("is 30 s, 1 m, 2 m, 5 m and then capped at 5 m", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(waitingBackoffMs)).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000]);
    expect(WAITING_BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
  });
  it("treats nonsense counts as the first step", () => {
    expect(waitingBackoffMs(0)).toBe(30_000);
    expect(waitingBackoffMs(-3)).toBe(30_000);
    expect(waitingBackoffMs(Number.NaN)).toBe(30_000);
  });
});

describe("waiting marker", () => {
  it("round-trips since, tries and kind, and carries a plain sentence", () => {
    const m = formatWaitingMarker({ since: T0, tries: 3, kind: "unavailable" });
    expect(m.startsWith("[printio:waiting")).toBe(true);
    expect(m).toContain(WAITING_UNAVAILABLE_TEXT);
    expect(parseWaitingMarker(m)).toEqual({ since: T0, tries: 3, kind: "unavailable", text: WAITING_UNAVAILABLE_TEXT });
  });
  it("uses the 'status unknown' sentence for the unknown kind", () => {
    const m = formatWaitingMarker({ since: T0, tries: 1, kind: "unknown" });
    expect(parseWaitingMarker(m)?.text).toBe(WAITING_UNKNOWN_TEXT);
    expect(WAITING_UNKNOWN_TEXT).toBe("Waiting for the printer - status unknown");
  });
  it("is tolerant: garbage, null, other messages and half-written markers are not waiting", () => {
    for (const bad of [null, undefined, "", "boom", "[printio:waiting", "spooler offline"]) expect(parseWaitingMarker(bad as string)).toBeNull();
  });
  it("is tolerant of missing or broken fields (still waiting, safe defaults)", () => {
    const p = parseWaitingMarker("[printio:waiting v1 tries=abc] something");
    expect(p).toMatchObject({ tries: 1, kind: "unknown" });
    expect(Number.isFinite(p?.since)).toBe(true);
    expect(parseWaitingMarker("[printio:waiting v1 since=nope tries=2 kind=weird]")).toMatchObject({ tries: 2, kind: "unknown" });
  });
});

describe("planRelease", () => {
  const W = DEFAULT_WAITING_WINDOW_MS;
  it("defaults to a two hour window", () => {
    expect(W).toBe(2 * 60 * 60 * 1000);
  });
  it("first release starts the clock now, tries=1, 30 s backoff, no previous marker", () => {
    const p = planRelease({ previous: null, now: T0, windowMs: W, kind: "unavailable" });
    expect(p).toMatchObject({ action: "wait", tries: 1, since: T0, retryAt: T0 + 30_000 });
    if (p.action === "wait") expect(parseWaitingMarker(p.message)).toMatchObject({ since: T0, tries: 1, kind: "unavailable" });
  });
  it("keeps the original 'since', counts tries and grows the backoff", () => {
    let prev: string | null = null;
    let now = T0;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = planRelease({ previous: prev, now, windowMs: W, kind: "unavailable" });
      if (p.action !== "wait") throw new Error("should wait");
      expect(p.since).toBe(T0);
      expect(p.tries).toBe(i + 1);
      delays.push(p.retryAt - now);
      prev = p.message;
      now = p.retryAt;
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
  });
  it("the latest kind wins (unknown can become unavailable once the cause is known)", () => {
    const a = planRelease({ previous: null, now: T0, windowMs: W, kind: "unknown" });
    if (a.action !== "wait") throw new Error("x");
    const b = planRelease({ previous: a.message, now: T0 + 30_000, windowMs: W, kind: "unavailable" });
    expect(b.action === "wait" && parseWaitingMarker(b.message)?.kind).toBe("unavailable");
  });
  it("fails once the job has been unprintable for the whole window", () => {
    const a = planRelease({ previous: null, now: T0, windowMs: W, kind: "unavailable" });
    if (a.action !== "wait") throw new Error("x");
    const justBefore = planRelease({ previous: a.message, now: T0 + W - 1, windowMs: W, kind: "unavailable" });
    expect(justBefore.action).toBe("wait");
    const atWindow = planRelease({ previous: a.message, now: T0 + W, windowMs: W, kind: "unavailable" });
    expect(atWindow.action).toBe("fail");
    if (atWindow.action === "fail") {
      expect(atWindow.message).toBe(gaveUpMessage(W));
      expect(parseGaveUp(atWindow.message)).toContain("2 hours");
      expect(parseGaveUp(atWindow.message)).toContain("Try again");
    }
  });
  it("a clock that went backwards never fails a job early", () => {
    const a = planRelease({ previous: null, now: T0, windowMs: W, kind: "unavailable" });
    if (a.action !== "wait") throw new Error("x");
    expect(planRelease({ previous: a.message, now: T0 - 10_000, windowMs: W, kind: "unavailable" }).action).toBe("wait");
  });
  it("a previous message that is not a marker (an old error text) is ignored: the clock starts now", () => {
    const p = planRelease({ previous: "spooler reported a failure", now: T0, windowMs: W, kind: "unavailable" });
    expect(p).toMatchObject({ action: "wait", tries: 1, since: T0 });
  });
  it("a window of zero or nonsense falls back to the default instead of failing instantly", () => {
    expect(planRelease({ previous: null, now: T0, windowMs: 0, kind: "unknown" }).action).toBe("wait");
    expect(planRelease({ previous: null, now: T0, windowMs: Number.NaN, kind: "unknown" }).action).toBe("wait");
  });
});

describe("gaveUpMessage", () => {
  it("is plain words with the window in it", () => {
    expect(parseGaveUp(gaveUpMessage(30 * 60_000))).toContain("30 minutes");
    expect(parseGaveUp(gaveUpMessage(60 * 60_000))).toContain("1 hour");
    expect(parseGaveUp("some other error")).toBeNull();
    expect(parseGaveUp(null)).toBeNull();
  });
});
