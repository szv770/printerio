import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_REFRESH_MS, MAX_AUTO_REFRESHES, UPDATE_REFRESH_MS, refreshIntervalMs } from "./command-refresh";

describe("command refresh cadence", () => {
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

describe("server/client boundary", () => {
  // A server page cannot call a function exported from a "use client" file (Next throws at runtime, vitest does not).
  it("keeps the cadence helper out of a client module", () => {
    const src = readFileSync(new URL("./command-refresh.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });
  it("the agent page does not import the helper from the client component", () => {
    const page = readFileSync(new URL("../../app/admin/agents/[agentId]/page.tsx", import.meta.url), "utf8");
    expect(page).not.toMatch(/import\s*\{[^}]*refreshIntervalMs[^}]*\}\s*from\s*"\.\/CommandAutoRefresh"/);
  });
});
