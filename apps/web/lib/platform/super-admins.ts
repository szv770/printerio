/**
 * Pure helpers for /platform/super-admins (app/platform/super-admins) -
 * promoting/demoting profiles.platform_role by email. The actual write is a
 * service-role update (RLS blocks it entirely for authenticated clients -
 * see private.prevent_platform_role_escalation,
 * supabase/migrations/0006_rls_policies.sql), so this module only contains
 * the logic worth unit-testing on its own: the lockout guard and the
 * case-insensitive email lookup helper.
 */

export interface DemotionGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Never let a super_admin lock the deployment - or themselves - out:
 *  1. An acting super_admin can never demote their own account, even when
 *     other super_admins exist (so a session doesn't lose its own platform
 *     access mid-task).
 *  2. The last remaining super_admin can never be demoted by anyone, since
 *     that would leave the deployment with zero super_admins and no path
 *     back in short of a direct database edit.
 */
export function checkSuperAdminDemotion(params: {
  targetUserId: string;
  actingUserId: string;
  totalSuperAdmins: number;
}): DemotionGuardResult {
  if (params.targetUserId === params.actingUserId) {
    return { allowed: false, reason: "You can't remove your own super-admin access." };
  }
  if (params.totalSuperAdmins <= 1) {
    return { allowed: false, reason: "Can't remove the last super admin - promote another account first." };
  }
  return { allowed: true };
}

/** Escapes Postgres ILIKE wildcard characters (% and _) in user input so an
 *  email lookup via `.ilike()` behaves as a plain case-insensitive equality
 *  check rather than a pattern match - "50%off@example.com" should search for
 *  that literal string, not "anything, then off@example.com". */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
