import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisibleInterval, type VisibilitySource } from "./visible-interval";

function fakeDoc(initial: "visible" | "hidden" = "visible") {
  let state = initial;
  const listeners = new Set<() => void>();
  const doc: VisibilitySource = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  return {
    doc,
    set: (s: "visible" | "hidden") => {
      state = s;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startVisibleInterval", () => {
  it("calls back every interval while the tab is visible", () => {
    const f = fakeDoc();
    const cb = vi.fn();
    startVisibleInterval(cb, 4000, f.doc);
    vi.advanceTimersByTime(12_000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses while the tab is hidden, and refreshes once immediately when it becomes visible again", () => {
    const f = fakeDoc();
    const cb = vi.fn();
    startVisibleInterval(cb, 4000, f.doc);
    f.set("hidden");
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    f.set("visible");
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not start at all when mounted in a hidden tab, until it is shown", () => {
    const f = fakeDoc("hidden");
    const cb = vi.fn();
    startVisibleInterval(cb, 4000, f.doc);
    vi.advanceTimersByTime(20_000);
    expect(cb).not.toHaveBeenCalled();
    f.set("visible");
    vi.advanceTimersByTime(4000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("cleans up completely on stop: no timer, no listener", () => {
    const f = fakeDoc();
    const cb = vi.fn();
    const stop = startVisibleInterval(cb, 4000, f.doc);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.set("visible");
    expect(cb).not.toHaveBeenCalled();
  });

  it("never runs two timers at once (visible event while already running)", () => {
    const f = fakeDoc();
    const cb = vi.fn();
    startVisibleInterval(cb, 4000, f.doc);
    f.set("visible");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("survives a callback that throws", () => {
    const f = fakeDoc();
    const cb = vi.fn(() => {
      throw new Error("x");
    });
    startVisibleInterval(cb, 4000, f.doc);
    expect(() => vi.advanceTimersByTime(8000)).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
