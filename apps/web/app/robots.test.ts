import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  it("allows public pages and blocks the app, the API and the preview", () => {
    const rule = [robots().rules].flat()[0]!;
    expect(rule.allow).toBe("/");
    expect(rule.disallow).toEqual(expect.arrayContaining(["/admin", "/api", "/dev"]));
  });
});
