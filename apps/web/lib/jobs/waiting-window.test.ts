import { describe, expect, it } from "vitest";
import { waitingWindowMs } from "./waiting-window";

describe("waitingWindowMs", () => {
  it("defaults to 2 hours", () => {
    expect(waitingWindowMs({})).toBe(2 * 60 * 60_000);
    expect(waitingWindowMs({ PRINTIO_WAITING_WINDOW_MINUTES: "" })).toBe(2 * 60 * 60_000);
  });
  it("reads PRINTIO_WAITING_WINDOW_MINUTES", () => {
    expect(waitingWindowMs({ PRINTIO_WAITING_WINDOW_MINUTES: "30" })).toBe(30 * 60_000);
    expect(waitingWindowMs({ PRINTIO_WAITING_WINDOW_MINUTES: "1440" })).toBe(24 * 60 * 60_000);
  });
  it("ignores nonsense and out-of-range values (never fails jobs instantly, never waits for ever)", () => {
    for (const v of ["abc", "0", "-5", "NaN", "999999"]) expect(waitingWindowMs({ PRINTIO_WAITING_WINDOW_MINUTES: v })).toBe(2 * 60 * 60_000);
  });
});
