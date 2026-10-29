import { describe, expect, it } from "vitest";
import { loadConfig, MIN_POLL_INTERVAL_SECONDS } from "../src/config.js";

const base = { PRINTIO_API_URL: "https://printio.example.org" } as NodeJS.ProcessEnv;

// Each poll cycle is 3 calls on Vercel's Hobby plan (Active CPU is the scarce resource). The floor is deliberate:
// an old .env with PRINTIO_POLL_INTERVAL_SECONDS=15 must not keep the fast cadence after an update.
describe("agent poll interval floor", () => {
  it("defaults to the floor (60s)", () => {
    expect(MIN_POLL_INTERVAL_SECONDS).toBe(60);
    expect(loadConfig({ env: base }).pollIntervalSeconds).toBe(60);
  });
  it("raises a faster value from an old .env up to the floor", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "15" } }).pollIntervalSeconds).toBe(60);
  });
  it("keeps a slower value", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "120" } }).pollIntervalSeconds).toBe(120);
  });
  it("still validates the max against the effective interval", () => {
    expect(() => loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "200", PRINTIO_MAX_POLL_INTERVAL_SECONDS: "100" } })).toThrow(/must be >=/);
  });
});
