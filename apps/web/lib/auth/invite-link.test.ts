import { describe, expect, it } from "vitest";
import { buildInviteUrl, inviteShareMessage, inviteStatus, isPlausibleInviteCode } from "./invite-link";

describe("invite link helpers", () => {
  it("builds a join link carrying the code", () => {
    expect(buildInviteUrl("https://printio.test/", "a1b2c3d4e5f6")).toBe("https://printio.test/join?code=a1b2c3d4e5f6");
  });
  it("encodes odd codes", () => {
    expect(buildInviteUrl("https://x.test", "a b")).toBe("https://x.test/join?code=a%20b");
  });
  it("writes a friendly share message with the link", () => {
    expect(inviteShareMessage("Beth Rivkah", "https://x.test/join?code=abc")).toBe(
      "You're invited to print at Beth Rivkah with Printio: https://x.test/join?code=abc",
    );
  });
  it("falls back when there is no org name", () => {
    expect(inviteShareMessage("", "https://x/j")).toBe("You're invited to print with Printio: https://x/j");
  });
  it("accepts only plausible codes", () => {
    expect(isPlausibleInviteCode("a1b2c3d4e5f6")).toBe(true);
    expect(isPlausibleInviteCode("")).toBe(false);
    expect(isPlausibleInviteCode("x".repeat(80))).toBe(false);
    expect(isPlausibleInviteCode("bad code!")).toBe(false);
    expect(isPlausibleInviteCode(null)).toBe(false);
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("active", () => {
    expect(inviteStatus({ usesCount: 0, maxUses: 5, expiresAt: null }, now)).toBe("active");
    expect(inviteStatus({ usesCount: 2, maxUses: null, expiresAt: "2026-10-30T00:00:00Z" }, now)).toBe("active");
  });
  it("used when the limit is reached", () => {
    expect(inviteStatus({ usesCount: 1, maxUses: 1, expiresAt: null }, now)).toBe("used");
  });
  it("expired when the date has passed (wins over used)", () => {
    expect(inviteStatus({ usesCount: 0, maxUses: 1, expiresAt: "2026-10-22T00:00:00Z" }, now)).toBe("expired");
    expect(inviteStatus({ usesCount: 1, maxUses: 1, expiresAt: "2026-10-22T00:00:00Z" }, now)).toBe("expired");
  });
});
