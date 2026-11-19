import { describe, expect, it } from "vitest";
import { failureCodeForFetch, failureCodeForLink, failureTitle, formatLimit, tooBigMessage, type LinkFailureCode } from "./messages";
import type { FetchFailure } from "./fetch-pdf";

describe("failure codes", () => {
  it.each<[FetchFailure, LinkFailureCode]>([
    ["not_shared", "needs_signin"],
    ["not_pdf", "not_supported"],
    ["too_big", "too_big"],
    ["timeout", "timeout"],
    ["not_found", "not_found"],
    ["bad_link", "invalid"],
    ["blocked", "blocked"],
    ["rate_limited", "blocked"],
    ["http", "blocked"],
    ["network", "try_again"],
  ])("%s -> %s", (reason, code) => {
    expect(failureCodeForFetch(reason)).toBe(code);
  });
  it("link problems keep their own code", () => {
    expect(failureCodeForLink("folder")).toBe("folder");
    expect(failureCodeForLink("needs_signin")).toBe("needs_signin");
  });
  it("every code has a plain heading, and an unknown one still reads fine", () => {
    const codes: LinkFailureCode[] = ["needs_signin", "folder", "not_supported", "too_big", "blocked", "timeout", "not_found", "invalid", "try_again"];
    for (const c of codes) expect(failureTitle(c).length).toBeGreaterThan(8);
    expect(failureTitle("needs_signin")).toMatch(/sign-in/i);
    expect(failureTitle("folder")).toMatch(/folder/i);
    expect(failureTitle("timeout")).toMatch(/too long/i);
    expect(failureTitle(undefined)).toMatch(/could not get/i);
  });
});

describe("size limit wording", () => {
  it("shows the limit the way people read it", () => {
    expect(formatLimit(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatLimit(10_000_000)).toBe("9.5 MB");
    expect(formatLimit(2 * 1024 * 1024)).toBe("2 MB");
  });
  it("too large names the limit", () => {
    expect(tooBigMessage(25 * 1024 * 1024)).toMatch(/larger than the 25 MB limit/);
  });
});
