import type { OrgRole, PolicyAction } from "@printio/shared";

/**
 * An org_admin submitting their own print job should almost never be
 * hard-blocked by a require_approval/deny policy outcome or a quota limit -
 * there's often no one else around to approve it, and testing the system as
 * the only admin an org has (a common first-run scenario) should never be
 * able to lock the admin out of their own printer. This is opt-out, not
 * opt-in: organization_settings.admins_bypass_restrictions defaults to true,
 * and an org can turn it off deliberately if it wants its own admins held to
 * the same rules as everyone else - see 0021_admin_bypass_restrictions.sql.
 *
 * This never changes what a rule/quota SAYS (policy_action/policy_reasons
 * are stored and shown exactly as evaluated) - only whether that outcome is
 * allowed to block the job. See docs/architecture.md sec 6.3.
 */
export function isAdminExemptFromRestrictions(role: OrgRole, adminsBypassRestrictions: boolean): boolean {
  return role === "org_admin" && adminsBypassRestrictions;
}

/**
 * Whether this bypass actually changed anything, for the audit trail
 * (print_jobs.policy_bypassed_for_admin) and the job detail page's warning
 * banner. False when the policy would have allowed the job anyway - there's
 * nothing to disclose as "overridden".
 */
export function didBypassChangeOutcome(exempt: boolean, policyAction: PolicyAction): boolean {
  return exempt && policyAction !== "allow";
}
