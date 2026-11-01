import { describe, expect, it } from "vitest";
import { loadConfig, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS } from "../src/config.js";

const base = { PRINTIO_API_URL: "https://printio.example.org" } as NodeJS.ProcessEnv;

// The site runs on the owner's own PC (no Vercel quota), so jobs are picked up within a few seconds.
describe("agent poll interval", () => {
  it("defaults to 3s with a 2s floor", () => {
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBe(3);
    expect(MIN_POLL_INTERVAL_SECONDS).toBe(2);
    expect(loadConfig({ env: base }).pollIntervalSeconds).toBe(3);
  });
  it("honours a value from .env at or above the floor", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "15" } }).pollIntervalSeconds).toBe(15);
    expect(loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "5" } }).pollIntervalSeconds).toBe(5);
  });
  it("raises anything below the floor up to it", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "1" } }).pollIntervalSeconds).toBe(2);
  });
  it("still validates the max against the effective interval", () => {
    expect(() => loadConfig({ env: { ...base, PRINTIO_POLL_INTERVAL_SECONDS: "200", PRINTIO_MAX_POLL_INTERVAL_SECONDS: "100" } })).toThrow(/must be >=/);
  });
});
