import { describe, expect, it } from "vitest";
import { hasSupabaseAuthCookie, isSupabaseAuthCookie } from "./auth-cookie";

describe("isSupabaseAuthCookie", () => {
  it.each(["sb-abc-auth-token", "sb-abc-auth-token.0", "sb-abc-auth-token.12"])("matches %s", (n) => {
    expect(isSupabaseAuthCookie(n)).toBe(true);
  });
  it.each(["sb-abc-auth-token-code-verifier", "theme", "sb-abc", "xsb-abc-auth-token"])("rejects %s", (n) => {
    expect(isSupabaseAuthCookie(n)).toBe(false);
  });
  it("hasSupabaseAuthCookie scans a list", () => {
    expect(hasSupabaseAuthCookie([{ name: "a" }, { name: "sb-x-auth-token.0" }])).toBe(true);
    expect(hasSupabaseAuthCookie([{ name: "a" }])).toBe(false);
  });
});
