import { describe, it, expect } from "vitest";
import { firstRunStatus, isUnbootstrapped } from "./first-run";

describe("firstRunStatus", () => {
  it("reports an ordinary no-access situation once any organization exists", () => {
    expect(
      firstRunStatus({ organizationCount: 1, bootstrapAdminConfigured: false, bootstrapEnvInvalid: false }),
    ).toEqual({ kind: "organization_exists" });
  });

  it("still reports organization_exists when the bootstrap var is somehow left set", () => {
    // bootstrap.ts's global guard makes the env var irrelevant the moment an
    // organization exists; the screen must agree with that, not offer to
    // bootstrap something that already happened.
    expect(
      firstRunStatus({ organizationCount: 3, bootstrapAdminConfigured: true, bootstrapEnvInvalid: false }),
    ).toEqual({ kind: "organization_exists" });
  });

  it("reports awaiting_bootstrap_admin on an empty deployment with the var configured", () => {
    expect(
      firstRunStatus({ organizationCount: 0, bootstrapAdminConfigured: true, bootstrapEnvInvalid: false }),
    ).toEqual({ kind: "awaiting_bootstrap_admin" });
  });

  it("reports bootstrap_not_configured on an empty deployment with no var", () => {
    expect(
      firstRunStatus({ organizationCount: 0, bootstrapAdminConfigured: false, bootstrapEnvInvalid: false }),
    ).toEqual({ kind: "bootstrap_not_configured" });
  });

  it("reports a typo'd bootstrap email ahead of the not-configured case", () => {
    expect(
      firstRunStatus({ organizationCount: 0, bootstrapAdminConfigured: false, bootstrapEnvInvalid: true }),
    ).toEqual({ kind: "bootstrap_env_invalid" });
  });
});

describe("isUnbootstrapped", () => {
  it("is false only when an organization exists", () => {
    expect(isUnbootstrapped({ kind: "organization_exists" })).toBe(false);
    expect(isUnbootstrapped({ kind: "awaiting_bootstrap_admin" })).toBe(true);
    expect(isUnbootstrapped({ kind: "bootstrap_not_configured" })).toBe(true);
    expect(isUnbootstrapped({ kind: "bootstrap_env_invalid" })).toBe(true);
  });
});
