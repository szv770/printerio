import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWaitController } from "./wait-controller";
import { SOMETHING_WENT_WRONG, watchLibraryWait, type WaitView } from "./wait-flow";
import { OFFLINE_MESSAGE, PENDING_MESSAGE, type LibraryOffline, type LibraryPending } from "./results";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const sec = (n: number) => n * 1000;
const pending: LibraryPending = { ok: false, pending: true, jobId: "j1", message: PENDING_MESSAGE };
const offline: LibraryOffline = { ok: false, offline: true, message: OFFLINE_MESSAGE };
type Page = { ok: true; page: string };
type Answer = Page | { ok: false; message: string };

/** One screen: a controller, the view it shows, and what it was given. */
function screen(answers: Array<() => Promise<Answer>>, over: { shown?: () => boolean; visible?: { now: boolean } } = {}) {
  const visible = over.visible ?? { now: true };
  const listeners = new Set<() => void>();
  const controller = createWaitController({
    isVisible: () => visible.now,
    onVisibilityChange: (l) => (listeners.add(l), () => listeners.delete(l)),
  });
  const s = {
    controller,
    visible,
    view: null as WaitView | null,
    ok: [] as string[],
    failed: [] as string[],
    asked: 0,
    hide: () => ((visible.now = false), listeners.forEach((l) => l())),
    reveal: () => ((visible.now = true), listeners.forEach((l) => l())),
    start(first: LibraryPending | LibraryOffline, key = "main") {
      watchLibraryWait<Page>({
        controller,
        key,
        first,
        isShown: over.shown ?? (() => true),
        ask: () => (answers[Math.min(s.asked++, answers.length - 1)] ?? (async () => pending))(),
        show: (next) => (s.view = typeof next === "function" ? next(s.view) : next),
        onOk: (r) => s.ok.push(r.page),
        onFail: (m) => s.failed.push(m),
      });
    },
  };
  return s;
}
const stays = async (): Promise<Answer> => pending;
const arrives = (page = "P") => async (): Promise<Answer> => ({ ok: true, page });

describe("a waiting result retries by itself", () => {
  it("shows the waiting state at once, asks after 5 s, and when the page arrives shows it and removes the waiting message", async () => {
    const s = screen([arrives("volume 3")]);
    s.start(pending);
    expect(s.view).toEqual({ kind: "pending", message: PENDING_MESSAGE, gaveUp: false, elapsedMs: 0 });
    await vi.advanceTimersByTimeAsync(sec(4));
    expect(s.asked).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(2));
    expect(s.asked).toBe(1);
    expect(s.ok).toEqual(["volume 3"]);
    expect(s.view).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(s.asked).toBe(1);
  });

  it("keeps asking (5 s, then 10 s, then 15 s apart) while it is still not there, and the seconds on screen grow", async () => {
    const s = screen([stays, stays, stays, arrives()]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(20));
    expect(s.asked).toBe(2); // at 5 s and 15 s
    expect(s.view).toMatchObject({ kind: "pending", gaveUp: false });
    expect(s.view!.elapsedMs).toBeGreaterThanOrEqual(19_000);
    await vi.advanceTimersByTimeAsync(sec(40));
    expect(s.asked).toBe(4); // 30 s and 45 s
    expect(s.ok).toEqual(["P"]);
    expect(s.view).toBeNull();
  });

  it("after about 90 s it gives up: the view says so (the Try again text and button), nothing more is asked", async () => {
    const s = screen([stays]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(89));
    expect(s.view).toMatchObject({ kind: "pending", gaveUp: false });
    await vi.advanceTimersByTimeAsync(sec(2));
    expect(s.view).toMatchObject({ kind: "pending", gaveUp: true });
    const asked = s.asked;
    expect(asked).toBeLessThanOrEqual(7);
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(s.asked).toBe(asked);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an error on a retry shows the error (not a waiting state) and stops", async () => {
    const s = screen([async () => ({ ok: false, message: "The print server could not get that page." })]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(s.failed).toEqual(["The print server could not get that page."]);
    expect(s.view).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry that throws shows the usual something-went-wrong sentence and stops", async () => {
    const s = screen([async () => { throw new Error("boom"); }]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(s.failed).toEqual([SOMETHING_WENT_WRONG]);
    expect(s.asked).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the print server going offline while waiting turns into the offline message, no more polling", async () => {
    const s = screen([async () => offline]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(200));
    expect(s.view).toEqual({ kind: "offline", message: OFFLINE_MESSAGE, gaveUp: false, elapsedMs: 0 });
    expect(s.asked).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a print server that is offline is never polled", () => {
  it("shows the message (and the screen its Try again button) and starts no timer", async () => {
    const s = screen([arrives()]);
    s.start(offline);
    expect(s.view).toEqual({ kind: "offline", message: OFFLINE_MESSAGE, gaveUp: false, elapsedMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(s.controller.size).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(s.asked).toBe(0);
  });

  it("an offline answer ends a wait that was running for the same item", async () => {
    const s = screen([arrives()]);
    s.start(pending);
    s.start(offline);
    expect(s.controller.active("main")).toBe(false);
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(s.asked).toBe(0);
  });
});

describe("it stops when the person moves on, and never runs two timers for one item", () => {
  it("stopping the wait (another tab, another entry, leaving) means no more questions and no timer", async () => {
    const s = screen([stays]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(6));
    s.controller.stopAll();
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(s.asked).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an answer that comes back after the person moved on is not shown", async () => {
    let release: (a: Answer) => void = () => {};
    const s = screen([() => new Promise<Answer>((r) => (release = r))]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(6));
    s.controller.stop("main");
    s.view = null;
    release({ ok: true, page: "late" });
    await vi.advanceTimersByTimeAsync(sec(1));
    expect(s.ok).toEqual([]);
    expect(s.failed).toEqual([]);
    expect(s.view).toBeNull();
  });

  it("when the item is no longer on screen nothing is started or shown", async () => {
    const s = screen([stays], { shown: () => false });
    s.start(pending);
    expect(s.view).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starting again for the same item (Try again) restarts the clock: one timer, one wait", async () => {
    const s = screen([stays]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(100));
    expect(s.view).toMatchObject({ gaveUp: true });
    s.start(pending);
    expect(s.view).toMatchObject({ kind: "pending", gaveUp: false, elapsedMs: 0 });
    expect(vi.getTimerCount()).toBe(1);
    expect(s.controller.size).toBe(1);
  });

  it("two items wait independently, each with its own single timer", async () => {
    const s = screen([stays]);
    s.start(pending, "main");
    s.start(pending, "entry:/maamorim/1");
    expect(s.controller.size).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    s.controller.stop("entry:/maamorim/1");
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("only while the tab is visible", () => {
  it("hiding the tab pauses the asking (no timer); showing it carries on and still ends with the page", async () => {
    const s = screen([stays, arrives("back")]);
    s.start(pending);
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(s.asked).toBe(1);
    s.hide();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(s.asked).toBe(1);
    s.reveal();
    await vi.advanceTimersByTimeAsync(sec(3));
    expect(s.asked).toBe(2);
    expect(s.ok).toEqual(["back"]);
  });
});
