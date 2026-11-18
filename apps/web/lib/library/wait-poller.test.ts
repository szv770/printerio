import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWaitPoller, waitDelayMs, waitingText, WAIT_CAP_MS, WAIT_DELAYS_MS, WAIT_GAVE_UP_TEXT } from "./wait-poller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const sec = (n: number) => n * 1000;

/** A poller whose `retry` answers "still waiting" (or what `answer` says) and records when it was asked, in seconds since start. */
function setup(over: { answer?: () => Promise<boolean>; visible?: { now: boolean } } = {}) {
  const t0 = Date.now();
  const asked: number[] = [];
  const events: string[] = [];
  const visible = over.visible ?? { now: true };
  const poller = createWaitPoller({
    retry: () => {
      asked.push((Date.now() - t0) / 1000);
      return (over.answer ?? (async () => true))();
    },
    onProgress: (ms) => events.push(`progress ${Math.round(ms / 1000)}`),
    onGiveUp: () => events.push("giveup"),
    onSettled: () => events.push("settled"),
    isVisible: () => visible.now,
  });
  return { poller, asked, events, visible, t0 };
}

describe("the delays and the texts", () => {
  it("5 s, then 10 s, then 15 s, and 15 s from then on", () => {
    expect(WAIT_DELAYS_MS).toEqual([5000, 10000, 15000]);
    expect([0, 1, 2, 3, 4, 10, 100].map(waitDelayMs)).toEqual([5000, 10000, 15000, 15000, 15000, 15000, 15000]);
  });

  it("the cap is 90 seconds", () => expect(WAIT_CAP_MS).toBe(90_000));

  it("the waiting sentence: plain at first, then 'about N seconds' in steps of 5", () => {
    expect(waitingText(0)).toBe("Waiting for your print server to fetch this page...");
    expect(waitingText(2400)).toBe("Waiting for your print server to fetch this page...");
    expect(waitingText(sec(5))).toBe("Waiting for your print server to fetch this page (about 5 seconds)");
    expect(waitingText(sec(17))).toBe("Waiting for your print server to fetch this page (about 15 seconds)");
    expect(waitingText(sec(88))).toBe("Waiting for your print server to fetch this page (about 90 seconds)");
    expect(WAIT_GAVE_UP_TEXT).toBe("This is taking longer than usual. Try again in a minute.");
  });
});

describe("the backoff sequence and the 90 s cap", () => {
  it("asks at 5, 15, 30, 45, 60 and 75 seconds, gives up once at 90 and never asks again", async () => {
    const { poller, asked, events } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(200));
    expect(asked).toEqual([5, 15, 30, 45, 60, 75]);
    expect(events.filter((e) => e === "giveup")).toHaveLength(1);
    expect(events).not.toContain("settled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not ask before the first 5 seconds are over", async () => {
    const { poller, asked } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(4));
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(sec(1));
    expect(asked).toEqual([5]);
  });

  it("measures each wait from the moment the last answer came in (a slow answer pushes the next one back)", async () => {
    let n = 0;
    const { poller, asked } = setup({ answer: () => new Promise((resolve) => setTimeout(() => resolve(true), n++ === 0 ? 3000 : 0)) });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(40));
    // first asked at 5, answered at 8, so the second is due at 18 (10 s later); it answers at 18.001 (fake timers count a 0 ms timeout as 1 ms), so the next beat that finds it due is 34
    expect(asked.slice(0, 3)).toEqual([5, 18, 34]);
  });

  it("gives up straight away when the next retry would fall after the cap", async () => {
    // Each answer takes 20 s: asked at 5 (answers 25, next due 35), at 35 (answers 55, next 70), at 70 (answers 90, next 105 > cap).
    const { poller, asked, events } = setup({ answer: () => new Promise((resolve) => setTimeout(() => resolve(true), 20_000)) });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(95));
    expect(asked).toEqual([5, 35, 70]);
    expect(events.filter((e) => e === "giveup")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(asked).toHaveLength(3);
  });

  it("reports the seconds waited as it goes", async () => {
    const { poller, events } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(3));
    expect(events).toEqual(["progress 1", "progress 2", "progress 3"]);
  });
});

describe("it stops when the question is settled", () => {
  it("the page arrived: no more questions, no timer left, onSettled once", async () => {
    let n = 0;
    const { poller, asked, events } = setup({ answer: async () => ++n < 3 });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(asked).toEqual([5, 15, 30]);
    expect(events.filter((e) => e === "settled")).toHaveLength(1);
    expect(events).not.toContain("giveup");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry that throws settles it too (no endless loop of errors)", async () => {
    const { poller, asked, events } = setup({ answer: async () => { throw new Error("boom"); } });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(asked).toEqual([5]);
    expect(events).toContain("settled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry that throws synchronously is handled the same way", async () => {
    const events: string[] = [];
    const poller = createWaitPoller({ retry: () => { throw new Error("sync boom"); }, onGiveUp: () => events.push("giveup"), onSettled: () => events.push("settled") });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(events).toEqual(["settled"]);
  });
});

describe("stop(): the person left, or opened something else", () => {
  it("stops at once: no timer, no more questions, nothing reported", async () => {
    const { poller, asked, events } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(20));
    const seen = events.length;
    poller.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(asked).toEqual([5, 15]);
    expect(events).toHaveLength(seen);
  });

  it("an answer that arrives after stop() is ignored: no new timer, no report", async () => {
    let finishRetry: (v: boolean) => void = () => undefined;
    const { poller, events } = setup({ answer: () => new Promise((resolve) => (finishRetry = resolve)) });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(5));
    poller.stop();
    finishRetry(true);
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(vi.getTimerCount()).toBe(0);
    expect(events).not.toContain("giveup");
    expect(events).not.toContain("settled");
  });

  it("stop() before start(), twice, and start() after stop() all do nothing harmful", async () => {
    const a = setup();
    a.poller.stop();
    a.poller.stop();
    a.poller.start();
    await vi.advanceTimersByTimeAsync(sec(100));
    expect(a.asked).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("never two timers for the same item", () => {
  it("start() twice, and visibility changes, still leave exactly one timer", async () => {
    const { poller, visible } = setup();
    poller.start();
    poller.start();
    expect(vi.getTimerCount()).toBe(1);
    poller.visibilityChanged();
    poller.visibilityChanged();
    expect(vi.getTimerCount()).toBe(1);
    visible.now = false;
    poller.visibilityChanged();
    expect(vi.getTimerCount()).toBe(0);
    visible.now = true;
    poller.visibilityChanged();
    poller.visibilityChanged();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("while a retry has not answered yet no second retry is made, however long it takes", async () => {
    const { poller, asked } = setup({ answer: () => new Promise(() => undefined) });
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(200));
    expect(asked).toEqual([5]);
  });
});

describe("only while the tab is visible", () => {
  it("a tab that is hidden from the start asks nothing and sets no timer until it is shown", async () => {
    const { poller, asked, visible } = setup({ visible: { now: false } });
    poller.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(asked).toEqual([]);
    visible.now = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(sec(2));
    expect(asked).toEqual([61]); // due long ago: asked at the first beat (one second) after the tab came back
  });

  it("switching away stops it immediately; coming back goes on within the same 90 s budget", async () => {
    const { poller, asked, visible, events } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(20));
    expect(asked).toEqual([5, 15]);
    visible.now = false;
    poller.visibilityChanged();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(20));
    expect(asked).toEqual([5, 15]);
    visible.now = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(sec(2));
    expect(asked).toEqual([5, 15, 41]);
    expect(events).not.toContain("giveup");
  });

  it("a beat that finds the tab hidden stops without asking (the event may not have been delivered)", async () => {
    const { poller, asked, visible } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(2));
    visible.now = false;
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(asked).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coming back after the cap has passed gives up instead of asking", async () => {
    const { poller, asked, visible, events } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(sec(3));
    visible.now = false;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(sec(200));
    visible.now = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(sec(2));
    expect(asked).toEqual([]);
    expect(events.filter((e) => e === "giveup")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
