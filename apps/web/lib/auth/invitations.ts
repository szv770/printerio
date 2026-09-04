import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export type RedeemInvitationResult =
  | { ok: true; organizationId: string; role: string }
  | { ok: false; reason: "not_found" | "expired" | "exhausted" | "email_mismatch" | "already_member" };

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
): Promise<RedeemInvitationResult> {
  const supabase = createServiceRoleClient();

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
  if (invitation.max_uses !== null && invitation.uses_count >= invitation.max_uses) {
    return { ok: false, reason: "exhausted" };
  }

  const { data: existing } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", invitation.organization_id)
    .maybeSingle();
  if (existing) return { ok: false, reason: "already_member" };

  const { error: insertError } = await supabase.from("organization_members").insert({
    user_id: userId,
    organization_id: invitation.organization_id,
    role: invitation.role,
    status: "active",
  });
  if (insertError) throw insertError;

  await supabase
    .from("organization_invitations")
    .update({ uses_count: invitation.uses_count + 1 })
    .eq("id", invitation.id);

  await supabase.from("audit_logs").insert({
    organization_id: invitation.organization_id,
    actor_id: userId,
    action: "invitation.redeemed",
    target_type: "organization_invitations",
    target_id: invitation.id,
    metadata: { role: invitation.role },
  });

  return { ok: true, organizationId: invitation.organization_id, role: invitation.role };
}

/** Generates a URL-safe random enrollment code (org_admin-facing, shown once). */
export function generateEnrollmentCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
