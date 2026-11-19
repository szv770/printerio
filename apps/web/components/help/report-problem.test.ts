import { describe, expect, it } from "vitest";
import { detailsText, reportBody, reportMailto, safePagePath } from "./report-problem";

const d = { page: "/jobs", digest: "abc123", build: "0.1.1 (a1b2c3d)", browser: "TestBrowser/1.0" };

describe("report a problem", () => {
  it("lists only the page, reference, version and browser", () => {
    const text = detailsText(d);
    expect(text.split("\n").filter(Boolean)).toEqual(["Page: /jobs", "Error reference: abc123", "Printio version: 0.1.1 (a1b2c3d)", "Browser: TestBrowser/1.0"]);
  });

  it("leaves out the reference when there is none", () => {
    expect(reportBody({ ...d, digest: null })).not.toContain("Error reference");
  });

  it("builds a mailto with a prefilled subject and body", () => {
    const url = reportMailto("help@example.org", d);
    expect(url.startsWith("mailto:help@example.org?subject=")).toBe(true);
    expect(decodeURIComponent(url.split("&body=")[1] ?? "")).toBe(reportBody(d));
  });

  it("drops the query string and hash from the page", () => {
    expect(safePagePath("/join?code=secret#x")).toBe("/join");
    expect(safePagePath(null)).toBe("/");
  });
});
