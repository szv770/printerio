import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { checkInviteGroup } from "@/lib/auth/invite-group";
import { checkInviteRateLimit } from "@/lib/auth/invite-rate-limit";

export type RedeemInvitationResult =
  | { ok: true; organizationId: string; role: string }
  | { ok: false; reason: "not_found" | "expired" | "exhausted" | "email_mismatch" | "already_member" | "rate_limited" };

/**
 * Redeems an enrollment code or targeted-email invitation, inserting the
 * organization_members row. Runs as service-role because the redeeming user
 * has no organization membership yet (so their own RLS session could not
 * insert this row themselves) - see docs/architecture.md sec 2.2.
 *
 * This is how staff/students get added to an org after the initial bootstrap
 * admin exists (org_admin creates the invitation from /admin/users).
 */
export async function redeemInvitation(
  code: string,
  userId: string,
  email: string,
  opts: { ip?: string } = {},
): Promise<RedeemInvitationResult> {
  const supabase = createServiceRoleClient();

  // Security review F13: stop code guessing (per user and per IP).
  if (!(await checkInviteRateLimit(supabase, { userId, ip: opts.ip }))) {
    return { ok: false, reason: "rate_limited" };
  }

  const { data: invitation, error } = await supabase
    .from("organization_invitations")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!invitation) return { ok: false, reason: "not_found" };

  if (invitation.email && invitation.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    return { ok: false, reason: "email_mismatch" };
  }
  if (invitation.expires_at && new Date(invitation.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const { data: existing } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", invitation.organization_id)
    .maybeSingle();
  if (existing) return { ok: false, reason: "already_member" };

  // Atomically claim one use of this code before inserting membership - via
  // the claim_invitation_use() RPC (supabase/migrations/0020_*.sql), not the
  // read-then-write this used to be (read invitation.uses_count above,
  // check < max_uses, write uses_count + 1 as a separate, client-computed
  // literal). That shape let two concurrent redemptions of the same code
  // both read the same uses_count, both pass the check, and both succeed -
  // a code capped at max_uses: N could admit N+k people under concurrent
  // redemption (e.g. a class of students all redeeming the same open
  // enrollment code around the same moment - this app's actual use case).
  // A client-side "read uses_count, send uses_count+1" pair can't be made
  // atomic no matter how the WHERE clause is phrased, because the value
  // being written is still computed from a possibly-stale read - the
  // increment itself has to happen inside the SQL statement
  // (`uses_count = uses_count + 1`), which PostgREST's .update() cannot
  // express (it only ever sends literal values, never a SQL expression) -
  // hence the RPC, mirroring adjust_monthly_usage's identical shape
  // (supabase/migrations/0010_quota_functions.sql) for the identical reason.
  // The invite's optional group must belong to the same organization (a deleted group is skipped).
  let groupId: string | null = null;
  if (invitation.group_id) {
    const { data: group } = await supabase.from("groups").select("organization_id").eq("id", invitation.group_id).maybeSingle();
    const check = checkInviteGroup({
      inviteOrgId: invitation.organization_id,
      groupId: invitation.group_id,
      groupOrgId: group?.organization_id ?? null,
    });
    if (!check.ok) return { ok: false, reason: "not_found" };
    groupId = check.groupId;
  }

  const { data: claimed, error: claimError } = await supabase.rpc("claim_invitation_use", {
    p_invitation_id: invitation.id,
  });
  if (claimError) throw claimError;
  if (!claimed) return { ok: false, reason: "exhausted" };

  const { error: insertError } = await supabase.from("organization_members").insert({
    user_id: userId,
    organization_id: invitation.organization_id,
    role: invitation.role,
    status: "active",
  });
  if (insertError) throw insertError;

  // Put the person in the invite's group. The membership above is already done, so a failure here must not
  // lock them out: log it in the audit trail and carry on (an admin can add them from Groups).
  let groupAdded = false;
  if (groupId) {
    const { error: groupError } = await supabase.from("group_members").upsert({ group_id: groupId, user_id: userId });
    groupAdded = !groupError;
  }

  await supabase.from("audit_logs").insert({
    organization_id: invitation.organization_id,
    actor_id: userId,
    action: "invitation.redeemed",
    target_type: "organization_invitations",
    target_id: invitation.id,
    metadata: { role: invitation.role, ...(groupId ? { group_id: groupId, group_added: groupAdded } : {}) },
  });

  return { ok: true, organizationId: invitation.organization_id, role: invitation.role };
}

/** Generates a URL-safe random enrollment code (org_admin-facing, shown once). */
export function generateEnrollmentCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
