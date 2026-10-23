/** Pure rule for an invite's optional group (no server-only imports so it is easy to test). */
export type InviteGroupCheck = { ok: true; groupId: string | null } | { ok: false };

/**
 * groupOrgId is the organization the invite's group actually belongs to (null when the group no longer exists).
 * A group from another organization is refused; a deleted group is simply skipped so the person still joins.
 */
export function checkInviteGroup(input: { inviteOrgId: string; groupId: string | null; groupOrgId: string | null }): InviteGroupCheck {
  if (!input.groupId) return { ok: true, groupId: null };
  if (input.groupOrgId === null) return { ok: true, groupId: null };
  if (input.groupOrgId !== input.inviteOrgId) return { ok: false };
  return { ok: true, groupId: input.groupId };
}
