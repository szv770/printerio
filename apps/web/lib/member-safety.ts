/**
 * Self-protection rules for the admin Users page (app/admin/users) - the
 * checks that stop an org_admin from accidentally locking their organization
 * out of its own admin tooling. Kept as pure functions, separate from the
 * Server Actions that call them, so the rules themselves are unit-testable
 * without a database - see lib/member-safety.test.ts.
 */

export interface MemberSafetyMember {
  userId: string;
  role: string;
  status: string;
}

/**
 * An org_admin disabling their own membership would lose access immediately -
 * including the ability to undo it, since every admin action on this page
 * (this one included) requires an active org_admin session. There is no
 * recovery path short of someone editing the database by hand, so this is
 * blocked outright, independent of how many other org admins exist.
 */
export function assertCanDisableSelf(actorUserId: string, targetUserId: string): string | null {
  if (actorUserId === targetUserId) {
    return "You can't disable your own account. Ask another org admin to do it.";
  }
  return null;
}

/**
 * Removing the last active org_admin leaves the organization with nobody who
 * can manage it - not even to undo the removal. This is checked against the
 * target being removed, not against who's doing the removing: a lone admin
 * removing themselves is the most likely way to hit it, but the same
 * organization-wide lockout happens no matter who triggers it, so the count
 * check applies either way.
 */
export function assertCanRemoveMember(target: MemberSafetyMember, activeAdminCount: number): string | null {
  if (target.role === "org_admin" && target.status === "active" && activeAdminCount <= 1) {
    return "You can't remove the only remaining org admin. Promote someone else first.";
  }
  return null;
}
