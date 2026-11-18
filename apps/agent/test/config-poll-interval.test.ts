import { describe, expect, it } from "vitest";
import { loadConfig, isLoopbackUrl, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS } from "../src/config.js";

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

describe("agent slow-down cap after an outage", () => {
  it("is 30 s when the website runs on this same PC, 300 s for a remote website", () => {
    expect(loadConfig({ env: { PRINTIO_API_URL: "http://127.0.0.1:3010" } as NodeJS.ProcessEnv }).maxPollIntervalSeconds).toBe(30);
    expect(loadConfig({ env: { PRINTIO_API_URL: "http://localhost:3010" } as NodeJS.ProcessEnv }).maxPollIntervalSeconds).toBe(30);
    expect(loadConfig({ env: base }).maxPollIntervalSeconds).toBe(300);
  });
  it("an explicit PRINTIO_MAX_POLL_INTERVAL_SECONDS still wins", () => {
    expect(loadConfig({ env: { PRINTIO_API_URL: "http://127.0.0.1:3010", PRINTIO_MAX_POLL_INTERVAL_SECONDS: "120" } as NodeJS.ProcessEnv }).maxPollIntervalSeconds).toBe(120);
  });
  it("a slow poll interval above 30 s lifts the loopback cap to it (the max can never be below the interval)", () => {
    expect(loadConfig({ env: { PRINTIO_API_URL: "http://127.0.0.1:3010", PRINTIO_POLL_INTERVAL_SECONDS: "60" } as NodeJS.ProcessEnv }).maxPollIntervalSeconds).toBe(60);
  });
  it("isLoopbackUrl", () => {
    expect(isLoopbackUrl("http://[::1]:3010")).toBe(true);
    expect(isLoopbackUrl("https://beta.printio.app")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
