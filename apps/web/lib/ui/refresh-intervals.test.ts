import { describe, expect, it } from "vitest";
import { ACTIVE_JOB_REFRESH_MS, HOME_REFRESH_MS } from "./refresh-intervals";

// Every router.refresh() re-runs a server page on Vercel (Active CPU is capped on the Hobby plan).
// These guard against drifting back to the old 4s / 15s polling.
describe("page refresh cadence", () => {
  it("home and admin refresh at most once a minute", () => {
    expect(HOME_REFRESH_MS).toBeGreaterThanOrEqual(60_000);
  });
  it("an active job refreshes no faster than every 15 seconds", () => {
    expect(ACTIVE_JOB_REFRESH_MS).toBeGreaterThanOrEqual(15_000);
  });
});
