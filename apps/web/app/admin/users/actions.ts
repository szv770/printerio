"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { normalizeUserCode } from "@/lib/jobs/user-code";
import { assertCanDisableSelf, assertCanRemoveMember } from "@/lib/member-safety";
import type { OrgRole } from "@printio/shared";

export interface InviteState {
  error?: string;
  code?: string;
}

const VALID_ROLES: OrgRole[] = ["org_admin", "approver", "staff", "student"];

/** Creates an enrollment code an admin shares out-of-band (email, printed
 *  slip, etc.) - see docs/architecture.md sec 2.2. Redemption happens at
 *  /no-access via lib/auth/invitations.ts. */
export async function createInvitationAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const session = await requireOrgRole(["org_admin"]);
  const role = String(formData.get("role") ?? "student");
  const maxUsesRaw = String(formData.get("maxUses") ?? "");
  const expiresInDaysRaw = String(formData.get("expiresInDays") ?? "");

  if (!VALID_ROLES.includes(role as OrgRole)) return { error: "Invalid role." };

  const maxUses = maxUsesRaw ? Math.max(1, parseInt(maxUsesRaw, 10) || 1) : null;
  const expiresInDays = expiresInDaysRaw ? Math.max(1, parseInt(expiresInDaysRaw, 10) || 1) : null;
  const code = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  const supabase = await createClient();
  const { error } = await supabase.from("organization_invitations").insert({
    organization_id: session.membership.organization_id,
    code,
    role,
    max_uses: maxUses,
    expires_at: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null,
    created_by: session.userId,
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't create that invitation code.") };

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminInvites);
  return { code };
}

export interface RoleChangeState {
  error?: string;
}

export async function changeMemberRoleAction(_prev: RoleChangeState, formData: FormData): Promise<RoleChangeState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!VALID_ROLES.includes(role as OrgRole)) return { error: "Invalid role." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_members")
    .update({ role })
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't change that member's role.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "member.role_changed",
    target_type: "organization_members",
    target_id: userId,
    metadata: { role },
  });

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminUserDetail(userId));
  return {};
}

export interface DepartmentChangeState {
  error?: string;
}

/** Sets organization_members.department - the free-text field quotas/policies
 *  can scope on (scope_type: "department"). Previously only editable by hand
 *  in Postgres; there was no admin UI path to it at all. */
export async function changeMemberDepartmentAction(
  _prev: DepartmentChangeState,
  formData: FormData,
): Promise<DepartmentChangeState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  const department = String(formData.get("department") ?? "").trim();

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_members")
    .update({ department: department || null })
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't change that member's department.") };

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminUserDetail(userId));
  return {};
}

export interface UserCodeChangeState {
  error?: string;
}

/** Sets organization_members.user_code - the short code stamped on page 1 of this member's printouts. Blank
 *  clears it (a new unique code is generated and saved the next time one is needed). Letters and digits only, unique per organization. */
export async function changeMemberUserCodeAction(
  _prev: UserCodeChangeState,
  formData: FormData,
): Promise<UserCodeChangeState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  const raw = String(formData.get("userCode") ?? "").trim();
  const code = raw === "" ? null : normalizeUserCode(raw);
  if (raw !== "" && !code) return { error: "Use 1-12 letters or digits, no spaces." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_members")
    .update({ user_code: code })
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId);
  if (error) {
    if ((error as { code?: string }).code === "23505") return { error: "Someone else already has that code." };
    return { error: describeDatabaseError(error, "Couldn't change that member's code.") };
  }

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminUserDetail(userId));
  return {};
}

export interface StatusChangeState {
  error?: string;
}

/** Toggles organization_members.status between "active" and "disabled" -
 *  previously a plain read-only column with no admin UI path to it at all
 *  (same gap changeMemberDepartmentAction closed for department). Disabling
 *  does not touch the profiles/auth.users row - the person's account still
 *  exists, they just lose org access (getCurrentSession only picks up
 *  status: "active" memberships). See lib/member-safety.ts for why an
 *  org_admin can't disable their own membership through this action. */
export async function toggleMemberStatusAction(_prev: StatusChangeState, formData: FormData): Promise<StatusChangeState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "active" && status !== "disabled") return { error: "Invalid status." };

  if (status === "disabled") {
    const selfError = assertCanDisableSelf(session.userId, userId);
    if (selfError) return { error: selfError };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_members")
    .update({ status })
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't change that member's status.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "member.status_changed",
    target_type: "organization_members",
    target_id: userId,
    metadata: { status },
  });

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminUserDetail(userId));
  return {};
}

export interface RemoveMemberState {
  error?: string;
  success?: boolean;
}

/** Removes someone from the organization (deletes their organization_members
 *  row only) - not their profiles/auth.users row, which is their identity,
 *  not their membership here. Removing them from this org should not delete
 *  their account, which may still be a member of other organizations or
 *  simply need to be re-invited later. See lib/member-safety.ts for why the
 *  last remaining active org_admin can't be removed this way. */
export async function removeMemberAction(_prev: RemoveMemberState, formData: FormData): Promise<RemoveMemberState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Missing member." };

  const supabase = await createClient();
  const { data: target } = await supabase
    .from("organization_members")
    .select("user_id, role, status")
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!target) return { error: "That member is no longer in this organization." };

  if (target.role === "org_admin" && target.status === "active") {
    const { count } = await supabase
      .from("organization_members")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", session.membership.organization_id)
      .eq("role", "org_admin")
      .eq("status", "active");
    const safetyError = assertCanRemoveMember({ userId: target.user_id, role: target.role, status: target.status }, count ?? 0);
    if (safetyError) return { error: safetyError };
  }

  const { error } = await supabase
    .from("organization_members")
    .delete()
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't remove that member.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "member.removed",
    target_type: "organization_members",
    target_id: userId,
    metadata: { role: target.role },
  });

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminUserDetail(userId));
  return { success: true };
}

export interface RevokeInvitationState {
  error?: string;
}

/** Deletes an unused organization_invitations row outright - e.g. one
 *  created with the wrong role, or that leaked. Redemption (lib/auth/
 *  invitations.ts) only ever reads a code that still exists, so this is a
 *  hard revoke: once deleted, the code stops working immediately. */
export async function revokeInvitationAction(_prev: RevokeInvitationState, formData: FormData): Promise<RevokeInvitationState> {
  const session = await requireOrgRole(["org_admin"]);
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return { error: "Missing invitation." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_invitations")
    .delete()
    .eq("organization_id", session.membership.organization_id)
    .eq("id", invitationId);
  if (error) return { error: describeDatabaseError(error, "Couldn't revoke that invitation.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "invitation.revoked",
    target_type: "organization_invitations",
    target_id: invitationId,
    metadata: {},
  });

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminInvites);
  return {};
}
