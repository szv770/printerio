import { describe, it, expect } from "vitest";
import { emailMatchesAllowedDomains, validateJoinSettings } from "./join-policy";

describe("emailMatchesAllowedDomains (mirror of the SQL rule)", () => {
  const list = ["lecfl.com"];
  it("matches the exact domain, case-insensitively", () => {
    expect(emailMatchesAllowedDomains("a@lecfl.com", list)).toBe(true);
    expect(emailMatchesAllowedDomains("A@LECFL.COM", list)).toBe(true);
  });
  it("rejects suffix, prefix and subdomain tricks", () => {
    expect(emailMatchesAllowedDomains("a@evil-lecfl.com", list)).toBe(false);
    expect(emailMatchesAllowedDomains("a@lecfl.com.evil.org", list)).toBe(false);
    expect(emailMatchesAllowedDomains("a@mail.lecfl.com", list)).toBe(false);
    expect(emailMatchesAllowedDomains("a@lecfl.co", list)).toBe(false);
  });
  it("allows a subdomain only when it is listed", () => {
    expect(emailMatchesAllowedDomains("a@mail.lecfl.com", ["mail.lecfl.com"])).toBe(true);
  });
  it("rejects malformed addresses and an empty list", () => {
    expect(emailMatchesAllowedDomains("lecfl.com", list)).toBe(false);
    expect(emailMatchesAllowedDomains("a@b@lecfl.com", list)).toBe(false);
    expect(emailMatchesAllowedDomains("a@lecfl.com", [])).toBe(false);
    expect(emailMatchesAllowedDomains("", list)).toBe(false);
  });
});

describe("validateJoinSettings", () => {
  it("invite only needs no domains", () => {
    expect(validateJoinSettings({ mode: "invite_only", domainsInput: "" })).toEqual({ ok: true, mode: "invite_only", domains: [] });
  });
  it("domain mode needs at least one valid domain", () => {
    const r = validateJoinSettings({ mode: "invite_or_domain", domainsInput: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one/i);
  });
  it("rejects emails and URLs with the offending entry named", () => {
    const r = validateJoinSettings({ mode: "invite_or_domain", domainsInput: "lecfl.com\nbob@x.org" });
    expect(r.ok).toBe(false);
  });
  it("normalises and de-duplicates", () => {
    expect(validateJoinSettings({ mode: "invite_or_domain", domainsInput: "LECFL.com, @lecfl.com" })).toEqual({
      ok: true,
      mode: "invite_or_domain",
      domains: ["lecfl.com"],
    });
  });
  it("rejects an unknown mode", () => {
    expect(validateJoinSettings({ mode: "anyone", domainsInput: "lecfl.com" }).ok).toBe(false);
  });
});
