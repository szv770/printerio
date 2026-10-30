import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

afterEach(() => vi.useRealTimers());

describe("debounce", () => {
  it("collapses a burst into one trailing call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    d();
    vi.advanceTimersByTime(1000);
    d();
    vi.advanceTimersByTime(1999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("cancel drops a pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
