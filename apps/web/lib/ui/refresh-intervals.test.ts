import { describe, expect, it } from "vitest";
import { ACTIVE_JOB_REFRESH_MS, HOME_REFRESH_MS } from "./refresh-intervals";

// The website runs on the owner's own PC, so a job in progress refreshes quickly. Not so fast that a tab hammers the server.
describe("page refresh cadence", () => {
  it("an active job refreshes every few seconds", () => {
    expect(ACTIVE_JOB_REFRESH_MS).toBeGreaterThanOrEqual(2_000);
    expect(ACTIVE_JOB_REFRESH_MS).toBeLessThanOrEqual(10_000);
  });
  it("home and admin dashboards refresh about every 30 seconds", () => {
    expect(HOME_REFRESH_MS).toBeGreaterThanOrEqual(15_000);
    expect(HOME_REFRESH_MS).toBeLessThanOrEqual(60_000);
  });
});
