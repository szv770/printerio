import { describe, expect, it } from "vitest";
import { isStale, jobSizeText, oldestWaitedText, timeAgo, HEARTBEAT_STALE_MS } from "./format";

const NOW = new Date("2026-03-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

describe("timeAgo", () => {
  it("says just now under a minute", () => expect(timeAgo(ago(20_000), NOW)).toBe("just now"));
  it("minutes", () => {
    expect(timeAgo(ago(MIN), NOW)).toBe("1 min ago");
    expect(timeAgo(ago(40 * MIN), NOW)).toBe("40 min ago");
  });
  it("hours", () => {
    expect(timeAgo(ago(60 * MIN), NOW)).toBe("1 h ago");
    expect(timeAgo(ago(5 * 60 * MIN), NOW)).toBe("5 h ago");
  });
  it("days", () => {
    expect(timeAgo(ago(24 * 60 * MIN), NOW)).toBe("1 day ago");
    expect(timeAgo(ago(3 * 24 * 60 * MIN), NOW)).toBe("3 days ago");
  });
  it("never goes negative on clock skew", () => expect(timeAgo(ago(-5 * MIN), NOW)).toBe("just now"));
  it("handles missing or invalid", () => {
    expect(timeAgo(null, NOW)).toBe("never");
    expect(timeAgo("garbage", NOW)).toBe("never");
  });
});

describe("oldestWaitedText", () => {
  it("is empty without a date", () => expect(oldestWaitedText(null, NOW)).toBe(""));
  it("under a minute", () => expect(oldestWaitedText(ago(10_000), NOW)).toBe("The oldest just arrived."));
  it("minutes, singular and plural", () => {
    expect(oldestWaitedText(ago(MIN), NOW)).toBe("The oldest has waited 1 minute.");
    expect(oldestWaitedText(ago(40 * MIN), NOW)).toBe("The oldest has waited 40 minutes.");
  });
  it("hours and days", () => {
    expect(oldestWaitedText(ago(2 * 60 * MIN), NOW)).toBe("The oldest has waited 2 hours.");
    expect(oldestWaitedText(ago(60 * MIN), NOW)).toBe("The oldest has waited 1 hour.");
    expect(oldestWaitedText(ago(2 * 24 * 60 * MIN), NOW)).toBe("The oldest has waited 2 days.");
  });
});

describe("isStale", () => {
  it("threshold is two minutes", () => expect(HEARTBEAT_STALE_MS).toBe(2 * MIN));
  it("fresh is not stale", () => expect(isStale(ago(90_000), NOW)).toBe(false));
  it("exactly at the threshold is not stale, past it is", () => {
    expect(isStale(ago(2 * MIN), NOW)).toBe(false);
    expect(isStale(ago(2 * MIN + 1000), NOW)).toBe(true);
  });
  it("never seen is stale", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale("nope", NOW)).toBe(true);
  });
});

describe("jobSizeText", () => {
  it("singular page, one copy", () => expect(jobSizeText(1, 1)).toBe("1 page"));
  it("pages and copies", () => expect(jobSizeText(12, 28)).toBe("12 pages · 28 copies"));
  it("one copy of many pages", () => expect(jobSizeText(12, 1)).toBe("12 pages"));
  it("tolerates junk", () => expect(jobSizeText(0, 0)).toBe(""));
});
