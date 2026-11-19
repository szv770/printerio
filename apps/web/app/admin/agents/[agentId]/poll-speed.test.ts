import { describe, expect, it } from "vitest";
import { pollSpeedLabel, pollSpeedSelectValue } from "./poll-speed";

describe("pollSpeedLabel", () => {
  it("treats null and undefined the same", () => {
    expect(pollSpeedLabel(null)).toBe("The PC's own setting");
    expect(pollSpeedLabel(undefined)).toBe("The PC's own setting");
    expect(pollSpeedLabel(undefined)).not.toContain("undefined");
  });
  it("uses the preset label, or a plain fallback", () => {
    expect(pollSpeedLabel(10)).toBe("Relaxed (every 10 seconds)");
    expect(pollSpeedLabel(45)).toBe("Every 45 seconds");
  });
  it("maps the select value", () => {
    expect(pollSpeedSelectValue(undefined)).toBe("");
    expect(pollSpeedSelectValue(null)).toBe("");
    expect(pollSpeedSelectValue(30)).toBe("30");
  });
});
