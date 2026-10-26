"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { removeUnmatchedSignup } from "@/lib/admin/unmatched-signups";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { normalizeUserCode } from "@/lib/jobs/user-code";
import { assertCanDemoteMember, assertCanDisableMember, assertCanDisableSelf, assertCanRemoveMember } from "@/lib/member-safety";
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
  // Optional group: it must be one of THIS organization's groups.
  const groupId = String(formData.get("groupId") ?? "").trim() || null;
  if (groupId) {
    const { data: group } = await supabase
      .from("groups")
      .select("id")
      .eq("id", groupId)
      .eq("organization_id", session.membership.organization_id)
      .maybeSingle();
    if (!group) return { error: "That group was not found. Pick one from the list." };
  }
  const { error } = await supabase.from("organization_invitations").insert({
    organization_id: session.membership.organization_id,
    code,
    role,
    group_id: groupId,
    max_uses: maxUses,
    expires_at: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null,
    created_by: session.userId,
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't create that invitation code.") };

  revalidatePath(routes.adminUsers);
  revalidatePath(routes.adminInvites);
  return { code };
}

/** How many ACTIVE org_admins this organization has (the number the last-admin guards compare against). */
async function countActiveAdmins(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: string): Promise<number> {
  const { count } = await supabase
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "org_admin")
    .eq("status", "active");
  return count ?? 0;
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

  // Demoting the only active org_admin would leave the organization with nobody who can manage it (same rule as
  // removing them; lib/member-safety.ts). Not atomic: two admins demoting each other in the same instant could
  // both pass - that needs a database-level guard, and is far less likely than the single-admin mistake caught here.
  const { data: target } = await supabase
    .from("organization_members")
    .select("user_id, role, status")
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!target) return { error: "That member is no longer in this organization." };
  if (target.role === "org_admin" && target.status === "active" && role !== "org_admin") {
    const safetyError = assertCanDemoteMember(
      { userId: target.user_id, role: target.role, status: target.status },
      role,
      await countActiveAdmins(supabase, session.membership.organization_id),
    );
    if (safetyError) return { error: safetyError };
  }

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

  // Disabling the last active org_admin locks the organization out of its own admin tools (lib/member-safety.ts).
  if (status === "disabled") {
    const { data: target } = await supabase
      .from("organization_members")
      .select("user_id, role, status")
      .eq("organization_id", session.membership.organization_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (target && target.role === "org_admin" && target.status === "active") {
      const safetyError = assertCanDisableMember(
        { userId: target.user_id, role: target.role, status: target.status },
        await countActiveAdmins(supabase, session.membership.organization_id),
      );
      if (safetyError) return { error: safetyError };
    }
  }

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

export interface EarlyToolsState {
  error?: string;
}

/** Switches "early tools" (print from a link, the booklet builder) on or off for one member. Admins always have them.
 *  Only an org admin can run this, and RLS only lets admins update membership rows, so nobody can switch it on for
 *  themselves. Scoped to the admin's own organization. */
export async function setMemberEarlyToolsAction(_prev: EarlyToolsState, formData: FormData): Promise<EarlyToolsState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  const enabledText = String(formData.get("enabled") ?? "");
  if (!userId) return { error: "Choose a person." };
  if (enabledText !== "true" && enabledText !== "false") return { error: "Invalid choice." };
  const enabled = enabledText === "true";

  const supabase = await createClient();
  const { error } = await supabase
    .from("organization_members")
    .update({ early_tools: enabled })
    .eq("organization_id", session.membership.organization_id)
    .eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't change early tools for that person.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "member.early_tools_changed",
    target_type: "organization_members",
    target_id: userId,
    metadata: { early_tools: enabled },
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

export interface RemoveSignupState {
  error?: string;
  success?: string;
}

/** Deletes a sign-up that has no access anywhere (Users > Sign-ups without access). Admin only; the org and actor
 *  come from the session, and the service refuses members, admins, super admins and yourself. */
export async function removeSignupAction(_prev: RemoveSignupState, formData: FormData): Promise<RemoveSignupState> {
  const session = await requireOrgRole(["org_admin"]);
  const userId = String(formData.get("userId") ?? "");
  if (!/^[\w-]{1,64}$/.test(userId)) return { error: "Choose an account to remove." };
  const result = await removeUnmatchedSignup(createServiceRoleClient(), {
    actorId: session.userId,
    organizationId: session.membership.organization_id,
    targetId: userId,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(routes.adminUsers);
  return { success: "Removed. They can still sign up again, but they will see nothing until you invite them." };
}
