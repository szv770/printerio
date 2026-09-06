import { describe, it, expect } from "vitest";
import { normalizeDomainInput, isValidDomain, parseAllowedDomainsInput, emailDomain } from "./domains";

describe("normalizeDomainInput", () => {
  it("lowercases and trims", () => {
    expect(normalizeDomainInput("  LECFL.com  ")).toBe("lecfl.com");
  });

  it("strips a scheme and path", () => {
    expect(normalizeDomainInput("https://lecfl.com/some/path")).toBe("lecfl.com");
  });

  it("strips a leading @", () => {
    expect(normalizeDomainInput("@lecfl.com")).toBe("lecfl.com");
  });

  it("reduces a full email to its domain", () => {
    expect(normalizeDomainInput("svogel@lecfl.com")).toBe("lecfl.com");
  });
});

describe("isValidDomain", () => {
  it("accepts a bare domain", () => {
    expect(isValidDomain("lecfl.com")).toBe(true);
    expect(isValidDomain("mail.lecfl.k12.oh.us")).toBe(true);
  });

  it("rejects an email address", () => {
    expect(isValidDomain("svogel@lecfl.com")).toBe(false);
  });

  it("rejects a URL", () => {
    expect(isValidDomain("https://lecfl.com")).toBe(false);
  });

  it("rejects a single label with no dot", () => {
    expect(isValidDomain("lecfl")).toBe(false);
  });

  it("rejects whitespace and empty strings", () => {
    expect(isValidDomain("lecfl .com")).toBe(false);
    expect(isValidDomain("")).toBe(false);
  });
});

describe("parseAllowedDomainsInput", () => {
  it("splits on commas and newlines", () => {
    const { domains, invalid } = parseAllowedDomainsInput("lecfl.com, other.org\nthird.edu");
    expect(domains).toEqual(["lecfl.com", "other.org", "third.edu"]);
    expect(invalid).toEqual([]);
  });

  it("normalizes and deduplicates", () => {
    const { domains } = parseAllowedDomainsInput("LECFL.com\nlecfl.com\n@lecfl.com");
    expect(domains).toEqual(["lecfl.com"]);
  });

  it("reports invalid entries instead of silently dropping them", () => {
    const { domains, invalid } = parseAllowedDomainsInput("lecfl.com, not an email@x.com is weird, bob@lecfl.com");
    expect(domains).toContain("lecfl.com");
    expect(invalid.length).toBeGreaterThan(0);
  });

  it("ignores blank lines and stray whitespace", () => {
    const { domains, invalid } = parseAllowedDomainsInput("\n\n  lecfl.com  \n\n,,\n");
    expect(domains).toEqual(["lecfl.com"]);
    expect(invalid).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseAllowedDomainsInput("").domains).toEqual([]);
  });
});

describe("emailDomain", () => {
  it("extracts the domain from an email", () => {
    expect(emailDomain("svogel@lecfl.com")).toBe("lecfl.com");
  });

  it("returns empty string for a value with no @", () => {
    expect(emailDomain("not-an-email")).toBe("");
  });
});
