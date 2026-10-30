import { describe, expect, it } from "vitest";
import { COMMAND_REFRESH_MS, MAX_AUTO_REFRESHES, UPDATE_REFRESH_MS, refreshIntervalMs } from "./CommandAutoRefresh";

describe("CommandAutoRefresh cadence", () => {
  it("polls every 5s during a live update and 10s otherwise", () => {
    expect(refreshIntervalMs(true)).toBe(5_000);
    expect(refreshIntervalMs(false)).toBe(10_000);
    expect(UPDATE_REFRESH_MS).toBeLessThan(COMMAND_REFRESH_MS);
  });
  it("is capped", () => {
    expect(MAX_AUTO_REFRESHES).toBeGreaterThan(0);
    expect(MAX_AUTO_REFRESHES * UPDATE_REFRESH_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
