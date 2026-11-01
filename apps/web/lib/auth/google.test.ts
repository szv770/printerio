import { describe, expect, it } from "vitest";
import { googleRedirectTo, googleErrorMessage } from "./google";

describe("googleRedirectTo", () => {
  it("returns to the auth callback on this site", () => {
    expect(googleRedirectTo("https://beta.printio.app")).toBe("https://beta.printio.app/auth/callback");
  });

  it("carries an invite code through the round trip, encoded", () => {
    expect(googleRedirectTo("https://beta.printio.app", "AB 12/3")).toBe("https://beta.printio.app/auth/callback?invite=AB%2012%2F3");
  });
});

describe("googleErrorMessage", () => {
  it("explains a provider that is not switched on yet", () => {
    expect(googleErrorMessage("Unsupported provider: provider is not enabled")).toMatch(/isn.t switched on/i);
  });

  it("falls back to a generic message without leaking details", () => {
    expect(googleErrorMessage("some internal thing")).toBe("Google sign-in didn't start. Try again, or use your email instead.");
  });
});

import { googleSignInEnabled } from "./google";

describe("googleSignInEnabled", () => {
  it("is off unless explicitly switched on (the provider must be enabled in Supabase first)", () => {
    expect(googleSignInEnabled(undefined)).toBe(false);
    expect(googleSignInEnabled("")).toBe(false);
    expect(googleSignInEnabled("0")).toBe(false);
    expect(googleSignInEnabled("1")).toBe(true);
  });
});
