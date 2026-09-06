import { describe, it, expect } from "vitest";
import { detectSignInProvider, isGoogleSignIn, GOOGLE_PROVIDER } from "./provider";

describe("detectSignInProvider", () => {
  it("returns the single identity's provider for a Google-only account", () => {
    const user = {
      app_metadata: { provider: "google" },
      identities: [{ provider: "google", last_sign_in_at: "2026-09-06T12:00:00.000Z" }],
    };
    expect(detectSignInProvider(user)).toBe("google");
  });

  it("returns the single identity's provider for a magic-link-only account", () => {
    const user = {
      app_metadata: { provider: "email" },
      identities: [{ provider: "email", last_sign_in_at: "2026-09-06T12:00:00.000Z" }],
    };
    expect(detectSignInProvider(user)).toBe("email");
  });

  it("picks the identity with the most recent last_sign_in_at when multiple are linked", () => {
    // Account originally signed up with Google, later linked a magic-link
    // identity too. app_metadata.provider would still say "google" (first
    // provider ever) - this must not be what the callback route trusts.
    const user = {
      app_metadata: { provider: "google" },
      identities: [
        { provider: "google", last_sign_in_at: "2026-01-01T00:00:00.000Z" },
        { provider: "email", last_sign_in_at: "2026-09-06T12:00:00.000Z" },
      ],
    };
    expect(detectSignInProvider(user)).toBe("email");
  });

  it("does not depend on identities array order", () => {
    const user = {
      identities: [
        { provider: "email", last_sign_in_at: "2026-09-06T12:00:00.000Z" },
        { provider: "google", last_sign_in_at: "2026-01-01T00:00:00.000Z" },
      ],
    };
    expect(detectSignInProvider(user)).toBe("email");
  });

  it("treats a missing last_sign_in_at as older than any timestamped identity", () => {
    const user = {
      identities: [
        { provider: "google" },
        { provider: "email", last_sign_in_at: "2026-09-06T12:00:00.000Z" },
      ],
    };
    expect(detectSignInProvider(user)).toBe("email");
  });

  it("falls back to app_metadata.provider when identities is empty", () => {
    const user = { app_metadata: { provider: "google" }, identities: [] };
    expect(detectSignInProvider(user)).toBe("google");
  });

  it("falls back to app_metadata.provider when identities is absent", () => {
    const user = { app_metadata: { provider: "email" } };
    expect(detectSignInProvider(user)).toBe("email");
  });

  it("returns null when nothing is available", () => {
    expect(detectSignInProvider({})).toBeNull();
  });
});

describe("isGoogleSignIn", () => {
  it("is true only for the google provider", () => {
    expect(isGoogleSignIn({ identities: [{ provider: GOOGLE_PROVIDER }] })).toBe(true);
    expect(isGoogleSignIn({ identities: [{ provider: "email" }] })).toBe(false);
    expect(isGoogleSignIn({})).toBe(false);
  });
});
