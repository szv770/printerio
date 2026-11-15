import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWaitController } from "./wait-controller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const sec = (n: number) => n * 1000;

/** A fake browser tab: whether it is visible, and the listeners the controller registered for "visibilitychange". */
function fakeTab() {
  const tab = {
    visible: true,
    listeners: new Set<() => void>(),
    subscribed: 0,
    unsubscribed: 0,
    set(visible: boolean) {
      tab.visible = visible;
      [...tab.listeners].forEach((l) => l());
    },
  };
  return tab;
}

function setup() {
  const tab = fakeTab();
  const ctl = createWaitController({
    isVisible: () => tab.visible,
    onVisibilityChange: (l) => {
      tab.subscribed++;
      tab.listeners.add(l);
      return () => {
        tab.unsubscribed++;
        tab.listeners.delete(l);
      };
    },
  });
  return { tab, ctl };
}

const stillWaiting = () => async () => true;

describe("one wait per item", () => {
  it("starting a wait for the same key replaces the old one: the old one never asks again, only one timer is left", async () => {
    const { ctl } = setup();
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => true);
    ctl.track("main", { retry: first, onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(first).toHaveBeenCalledTimes(1);
    ctl.track("main", { retry: second, onGiveUp: vi.fn() });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(sec(60));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second.mock.calls.length).toBeGreaterThan(2);
    expect(ctl.size).toBe(1);
  });

  it("different items each get their own wait, and stopping one leaves the other running", async () => {
    const { ctl } = setup();
    const a = vi.fn(async () => true);
    const b = vi.fn(async () => true);
    ctl.track("entry:/a", { retry: a, onGiveUp: vi.fn() });
    ctl.track("entry:/b", { retry: b, onGiveUp: vi.fn() });
    expect(ctl.size).toBe(2);
    ctl.stop("entry:/a");
    await vi.advanceTimersByTimeAsync(sec(20));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(ctl.active("entry:/a")).toBe(false);
    expect(ctl.active("entry:/b")).toBe(true);
  });
});

describe("stopping", () => {
  it("stop() ends the wait at once: nothing is asked, nothing is reported, no timer is left", async () => {
    const { ctl } = setup();
    const retry = vi.fn(async () => true);
    const onProgress = vi.fn();
    const onGiveUp = vi.fn();
    ctl.track("main", { retry, onProgress, onGiveUp });
    await vi.advanceTimersByTimeAsync(sec(2));
    ctl.stop("main");
    onProgress.mockClear();
    await vi.advanceTimersByTimeAsync(sec(200));
    expect(retry).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an answer that comes back after stop() is told it is no longer current (so the screen does not show it)", async () => {
    const { ctl } = setup();
    let release: (v: boolean) => void = () => {};
    let current: (() => boolean) | undefined;
    ctl.track("main", {
      retry: (isCurrent) => {
        current = isCurrent;
        return new Promise<boolean>((r) => (release = r));
      },
      onGiveUp: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(current!()).toBe(true);
    ctl.stop("main");
    expect(current!()).toBe(false);
    release(false);
    await vi.advanceTimersByTimeAsync(sec(5));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a replaced wait is no longer current either", async () => {
    const { ctl } = setup();
    let current: (() => boolean) | undefined;
    ctl.track("main", { retry: (c) => ((current = c), new Promise<boolean>(() => {})), onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(sec(6));
    ctl.track("main", { retry: stillWaiting(), onGiveUp: vi.fn() });
    expect(current!()).toBe(false);
  });

  it("stopAll() stops everything, or everything except what `keep` allows", async () => {
    const { ctl } = setup();
    for (const k of ["main", "entry:/a", "entry:/b"]) ctl.track(k, { retry: stillWaiting(), onGiveUp: vi.fn() });
    ctl.stopAll((k) => k === "entry:/b");
    expect([ctl.active("main"), ctl.active("entry:/a"), ctl.active("entry:/b")]).toEqual([false, false, true]);
    ctl.stopAll();
    expect(ctl.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("how it ends", () => {
  it("the page arrived: onSettled once, the wait is gone and nothing is left running", async () => {
    const { ctl } = setup();
    const onSettled = vi.fn();
    ctl.track("main", { retry: async () => false, onSettled, onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(ctl.active("main")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after about 90 seconds it gives up once (the screen then shows the 'taking longer' text), and the wait is over", async () => {
    const { ctl } = setup();
    const retry = vi.fn(async () => true);
    const onGiveUp = vi.fn();
    ctl.track("main", { retry, onGiveUp });
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(6);
    expect(ctl.active("main")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the same item can wait again afterwards (the Try again button), with a fresh 90 seconds", async () => {
    const { ctl } = setup();
    const onGiveUp = vi.fn();
    ctl.track("main", { retry: stillWaiting(), onGiveUp });
    await vi.advanceTimersByTimeAsync(sec(120));
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    const retry = vi.fn(async () => true);
    ctl.track("main", { retry, onGiveUp });
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(sec(300));
    expect(onGiveUp).toHaveBeenCalledTimes(2);
  });

  it("progress is reported while waiting", async () => {
    const { ctl } = setup();
    const seen: number[] = [];
    ctl.track("main", { retry: stillWaiting(), onProgress: (ms) => seen.push(Math.round(ms / 1000)), onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(sec(3));
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("only while the tab is visible, with one listener for all", () => {
  it("one visibility listener is added with the first wait and removed with the last", async () => {
    const { ctl, tab } = setup();
    ctl.track("a", { retry: stillWaiting(), onGiveUp: vi.fn() });
    ctl.track("b", { retry: stillWaiting(), onGiveUp: vi.fn() });
    expect(tab.subscribed).toBe(1);
    expect(tab.listeners.size).toBe(1);
    ctl.stop("a");
    expect(tab.listeners.size).toBe(1);
    ctl.stop("b");
    expect(tab.listeners.size).toBe(0);
    expect(tab.unsubscribed).toBe(1);
  });

  it("a wait that gave up or settled releases the listener too", async () => {
    const { ctl, tab } = setup();
    ctl.track("a", { retry: async () => false, onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(sec(30));
    expect(tab.listeners.size).toBe(0);
  });

  it("a hidden tab stops the asking at once, and showing it again carries on", async () => {
    const { ctl, tab } = setup();
    const retry = vi.fn(async () => true);
    ctl.track("main", { retry, onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(sec(6));
    expect(retry).toHaveBeenCalledTimes(1);
    tab.set(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(sec(40));
    expect(retry).toHaveBeenCalledTimes(1);
    tab.set(true);
    await vi.advanceTimersByTimeAsync(sec(2));
    expect(retry).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a hidden tab pauses every wait, and showing it twice in a row never makes two timers for one item", async () => {
    const { ctl, tab } = setup();
    ctl.track("a", { retry: stillWaiting(), onGiveUp: vi.fn() });
    ctl.track("b", { retry: stillWaiting(), onGiveUp: vi.fn() });
    tab.set(false);
    expect(vi.getTimerCount()).toBe(0);
    tab.set(true);
    tab.set(true);
    expect(vi.getTimerCount()).toBe(2);
  });
});

describe("with the real document (no fake given)", () => {
  it("uses document.visibilityState and its visibilitychange event", async () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "visible",
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    };
    vi.stubGlobal("document", doc);
    try {
      const ctl = createWaitController();
      const retry = vi.fn(async () => true);
      ctl.track("main", { retry, onGiveUp: vi.fn() });
      expect(listeners.size).toBe(1);
      doc.visibilityState = "hidden";
      [...listeners].forEach((l) => l());
      await vi.advanceTimersByTimeAsync(sec(30));
      expect(retry).not.toHaveBeenCalled();
      doc.visibilityState = "visible";
      [...listeners].forEach((l) => l());
      await vi.advanceTimersByTimeAsync(sec(6));
      expect(retry).toHaveBeenCalledTimes(1);
      ctl.stopAll();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
