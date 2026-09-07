import { describe, it, expect } from "vitest";
import { shortSha, formatBuildAge } from "./build-info";

describe("shortSha", () => {
  it("shortens to the 7 characters git itself shows", () => {
    expect(shortSha("acf4a1a9f2b3c4d5e6f708192a3b4c5d6e7f8091")).toBe("acf4a1a");
  });

  it("passes through an already-short sha unchanged", () => {
    expect(shortSha("acf4a1a")).toBe("acf4a1a");
  });

  it("returns null for a missing or blank sha", () => {
    expect(shortSha(null)).toBeNull();
    expect(shortSha("   ")).toBeNull();
  });
});

describe("formatBuildAge", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");

  it("returns null when the build time is missing or unparseable", () => {
    expect(formatBuildAge(null, now)).toBeNull();
    expect(formatBuildAge("not a date", now)).toBeNull();
  });

  it("reports minutes under an hour", () => {
    expect(formatBuildAge("2026-09-07T11:45:00.000Z", now)).toBe("15 minutes ago");
    expect(formatBuildAge("2026-09-07T11:59:00.000Z", now)).toBe("1 minute ago");
  });

  it("reports hours under a day", () => {
    expect(formatBuildAge("2026-09-07T06:00:00.000Z", now)).toBe("6 hours ago");
    expect(formatBuildAge("2026-09-07T11:00:00.000Z", now)).toBe("1 hour ago");
  });

  it("reports days beyond that - the case that flags a stalled deploy", () => {
    expect(formatBuildAge("2026-09-01T12:00:00.000Z", now)).toBe("6 days ago");
    expect(formatBuildAge("2026-09-06T12:00:00.000Z", now)).toBe("1 day ago");
  });

  it("clamps clock skew to 'just now' instead of a negative age", () => {
    expect(formatBuildAge("2026-09-07T12:00:30.000Z", now)).toBe("just now");
    expect(formatBuildAge("2026-09-07T12:05:00.000Z", now)).toBe("just now");
  });
});
