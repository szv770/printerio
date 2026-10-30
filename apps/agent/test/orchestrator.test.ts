import { describe, expect, it } from "vitest";
import { AUTH_FAILURE_BACKOFF_MS, AUTH_FAILURE_THRESHOLD, applyCycleJitter, classifyCycleOutcome, computeNextPollDelayMs, nextConsecutiveFailures, nextSleepMs } from "../src/orchestrator.js";

describe("classifyCycleOutcome", () => {
  it("is 'success' when all three sub-polls reached the cloud", () => {
    expect(classifyCycleOutcome([true, true, true])).toBe("success");
  });

  it("is 'failure' only when ALL three sub-polls failed (a total outage)", () => {
    expect(classifyCycleOutcome([false, false, false])).toBe("failure");
  });

  it("is 'partial' when some succeeded and some failed - a single flaky endpoint, not a total outage", () => {
    expect(classifyCycleOutcome([true, false, true])).toBe("partial");
    expect(classifyCycleOutcome([false, true, false])).toBe("partial");
    expect(classifyCycleOutcome([true, true, false])).toBe("partial");
  });
});

describe("nextConsecutiveFailures", () => {
  it("increments the counter on a 'failure' outcome", () => {
    expect(nextConsecutiveFailures("failure", 0)).toBe(1);
    expect(nextConsecutiveFailures("failure", 1)).toBe(2);
    expect(nextConsecutiveFailures("failure", 4)).toBe(5);
  });

  it("resets the counter to 0 immediately on a 'success' outcome, regardless of prior streak", () => {
    expect(nextConsecutiveFailures("success", 0)).toBe(0);
    expect(nextConsecutiveFailures("success", 1)).toBe(0);
    expect(nextConsecutiveFailures("success", 7)).toBe(0);
  });

  it("holds the counter steady on a 'partial' outcome - neither escalates nor resets", () => {
    expect(nextConsecutiveFailures("partial", 0)).toBe(0);
    expect(nextConsecutiveFailures("partial", 3)).toBe(3);
  });
});

describe("computeNextPollDelayMs", () => {
  const BASE_SECONDS = 15;
  const MAX_SECONDS = 300;

  it("returns exactly the base interval with no consecutive failures - the happy-path cadence must be unchanged", () => {
    expect(computeNextPollDelayMs(0, BASE_SECONDS, MAX_SECONDS)).toBe(15_000);
  });

  it("doubles the delay for each consecutive failure", () => {
    expect(computeNextPollDelayMs(1, BASE_SECONDS, MAX_SECONDS)).toBe(30_000);
    expect(computeNextPollDelayMs(2, BASE_SECONDS, MAX_SECONDS)).toBe(60_000);
    expect(computeNextPollDelayMs(3, BASE_SECONDS, MAX_SECONDS)).toBe(120_000);
    expect(computeNextPollDelayMs(4, BASE_SECONDS, MAX_SECONDS)).toBe(240_000);
  });

  it("caps the delay at the configured maximum once doubling would exceed it", () => {
    // 15s * 2^5 = 480s, which exceeds the 300s cap.
    expect(computeNextPollDelayMs(5, BASE_SECONDS, MAX_SECONDS)).toBe(300_000);
    expect(computeNextPollDelayMs(6, BASE_SECONDS, MAX_SECONDS)).toBe(300_000);
    expect(computeNextPollDelayMs(20, BASE_SECONDS, MAX_SECONDS)).toBe(300_000);
  });

  it("a reset (0 consecutive failures) snaps straight back to the base interval - no gradual ramp-down", () => {
    const escalated = computeNextPollDelayMs(4, BASE_SECONDS, MAX_SECONDS);
    expect(escalated).toBeGreaterThan(15_000);
    expect(computeNextPollDelayMs(0, BASE_SECONDS, MAX_SECONDS)).toBe(15_000);
  });

  it("respects a different base/max configuration", () => {
    expect(computeNextPollDelayMs(0, 30, 600)).toBe(30_000);
    expect(computeNextPollDelayMs(1, 30, 600)).toBe(60_000);
    expect(computeNextPollDelayMs(10, 30, 600)).toBe(600_000);
  });
});

describe("cycle jitter and auth-failure backoff", () => {
  it("applyCycleJitter adds a continuous 0-10% on top, never shortens the sleep", () => {
    expect(applyCycleJitter(60_000, () => 0)).toBe(60_000);
    expect(applyCycleJitter(60_000, () => 0.5)).toBe(63_000);
    expect(applyCycleJitter(60_000, () => 0.999999)).toBeLessThanOrEqual(66_000);
    expect(applyCycleJitter(60_000, () => 0.999999)).toBeGreaterThan(65_900);
  });

  it("backs off to ~10 minutes after 5 consecutive auth failures, otherwise leaves the delay alone", () => {
    expect(AUTH_FAILURE_THRESHOLD).toBe(5);
    expect(AUTH_FAILURE_BACKOFF_MS).toBe(10 * 60_000);
    expect(nextSleepMs(60_000, 4, () => 0)).toBe(60_000);
    expect(nextSleepMs(60_000, 5, () => 0)).toBe(AUTH_FAILURE_BACKOFF_MS);
    expect(nextSleepMs(20 * 60_000, 9, () => 0)).toBe(20 * 60_000); // never shortens a longer outage backoff
    expect(nextSleepMs(60_000, 5, () => 0.5)).toBe(AUTH_FAILURE_BACKOFF_MS * 1.05);
  });
});
