/**
 * "Has this deployment been bootstrapped yet, and if not, what is stopping
 * it?" - the pure decision behind the /no-access screen.
 *
 * Before this existed, someone who signed in to a brand-new deployment before
 * any organization existed landed on the ordinary "ask your organization
 * administrator for an enrollment code" screen. On a deployment with zero
 * organizations that advice is impossible to follow: there is no
 * administrator yet, and no admin exists who could issue a code. The person
 * reading it *is* the administrator, and what they actually need to know is
 * that PRINTIO_BOOTSTRAP_ADMIN_EMAIL (lib/auth/bootstrap.ts) hasn't taken
 * effect on the deployment they're looking at.
 *
 * What is deliberately NOT decided here: whether the viewer's own email
 * matches the configured bootstrap email. That comparison stays entirely
 * inside maybeBootstrapOrganization() - telling a visitor "you are/aren't the
 * configured bootstrap admin" would turn this screen into an oracle for
 * guessing a config value. Whether *any* organization exists, and whether the
 * variable is configured at all, are both safe to state: they describe the
 * deployment, not any person, and this state only exists on a deployment that
 * holds no data yet.
 */

export type FirstRunStatus =
  /** At least one organization exists - the bootstrap path is permanently
   *  closed (see lib/auth/bootstrap.ts) and this really is an ordinary
   *  "you need an enrollment code" situation. */
  | { kind: "organization_exists" }
  /** No organization yet, but PRINTIO_BOOTSTRAP_ADMIN_EMAIL is configured and
   *  valid: signing in as exactly that account creates the organization. */
  | { kind: "awaiting_bootstrap_admin" }
  /** No organization, and this running deployment can't see a
   *  PRINTIO_BOOTSTRAP_ADMIN_EMAIL value at all - the usual cause is that the
   *  variable was added in the host's dashboard but the deployment serving
   *  this request was built before it. */
  | { kind: "bootstrap_not_configured" }
  /** No organization, and PRINTIO_BOOTSTRAP_ADMIN_EMAIL is set to something
   *  that isn't a valid email address - a typo that would otherwise fail
   *  silently on every sign-in. */
  | { kind: "bootstrap_env_invalid" };

export interface FirstRunInputs {
  /** Count of rows in `organizations` across the whole deployment. */
  organizationCount: number;
  /** True when PRINTIO_BOOTSTRAP_ADMIN_EMAIL parsed as a valid email. */
  bootstrapAdminConfigured: boolean;
  /** True when the variable is present but rejected by the env schema. */
  bootstrapEnvInvalid: boolean;
}

export function firstRunStatus({
  organizationCount,
  bootstrapAdminConfigured,
  bootstrapEnvInvalid,
}: FirstRunInputs): FirstRunStatus {
  // Order matters: an existing organization wins over everything, because
  // once any organization exists the bootstrap path is dead regardless of
  // how the env var is set (bootstrap.ts's global guard).
  if (organizationCount > 0) return { kind: "organization_exists" };
  if (bootstrapEnvInvalid) return { kind: "bootstrap_env_invalid" };
  if (bootstrapAdminConfigured) return { kind: "awaiting_bootstrap_admin" };
  return { kind: "bootstrap_not_configured" };
}

/** True for every state where the visitor is looking at a deployment that has
 *  never been set up - i.e. "ask your administrator for a code" is not
 *  actionable advice and must not be the whole message. */
export function isUnbootstrapped(status: FirstRunStatus): boolean {
  return status.kind !== "organization_exists";
}
