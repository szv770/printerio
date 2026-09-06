import { describe, it, expect } from "vitest";
import { isReauthRequired, REAUTH_MAX_AGE_DAYS } from "./reauth";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("isReauthRequired", () => {
  it("does not require reauth just under the limit", () => {
    expect(isReauthRequired(daysAgo(REAUTH_MAX_AGE_DAYS - 1), NOW)).toBe(false);
  });

  it("requires reauth once strictly past the limit", () => {
    expect(isReauthRequired(daysAgo(REAUTH_MAX_AGE_DAYS + 1), NOW)).toBe(true);
  });

  it("does not require reauth for a session authenticated moments ago", () => {
    expect(isReauthRequired(NOW.toISOString(), NOW)).toBe(false);
  });

  it("treats a null timestamp as expired (fail closed)", () => {
    expect(isReauthRequired(null, NOW)).toBe(true);
  });

  it("treats an unparseable timestamp as expired (fail closed)", () => {
    expect(isReauthRequired("not-a-date", NOW)).toBe(true);
  });
});
