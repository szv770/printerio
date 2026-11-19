import { describe, expect, it } from "vitest";
import sitemap from "./sitemap";

describe("sitemap", () => {
  it("lists exactly the public pages", () => {
    const paths = sitemap().map((e) => e.url);
    expect(paths).toEqual(["/", "/privacy", "/terms", "/login"]);
    expect(paths.some((p) => p.includes("admin") || p.includes("api") || p.includes("dev"))).toBe(false);
  });
});
