"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { describeDatabaseError } from "@/lib/action-errors";
import { checkSuperAdminDemotion, escapeLikePattern, normalizeEmail } from "@/lib/platform/super-admins";
import { routes } from "@/lib/routes";

export interface SuperAdminActionState {
  error?: string;
  success?: string;
}
const initial: SuperAdminActionState = {};
export { initial as initialSuperAdminActionState };

type ServiceRoleClient = ReturnType<typeof createServiceRoleClient>;

type FindProfileResult =
  | { ok: true; profile: { id: string; email: string; platform_role: string } | null }
  | { ok: false; error: string };

/** Case-insensitive exact-match lookup - see lib/platform/super-admins.ts for
 *  why this goes through `.ilike()` with escaped wildcards rather than a
 *  plain `.eq()` (profiles.email has no case-normalizing constraint). */
async function findProfileByEmail(supabase: ServiceRoleClient, rawEmail: string): Promise<FindProfileResult> {
  const normalized = normalizeEmail(rawEmail);
  if (!normalized) return { ok: false, error: "Enter an email address." };

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, platform_role")
    .ilike("email", escapeLikePattern(normalized));
  if (error) return { ok: false, error: describeDatabaseError(error, "Couldn't look up that email.") };

  const profile = (data ?? []).find((p) => normalizeEmail(p.email) === normalized) ?? null;
  return { ok: true, profile };
}

/**
 * Promotes an existing profile to platform_role='super_admin'. The account
 * must already have a profiles row (i.e. have signed in at least once) -
 * this never creates auth.users/profiles rows itself, only changes an
 * existing one's platform flag.
 *
 * Goes through the service-role client because that's the only path
 * private.prevent_platform_role_escalation allows at all - an authenticated
 * client's UPDATE on profiles.platform_role is rejected outright by that
 * trigger regardless of RLS policy (supabase/migrations/0006_rls_policies.sql).
 */
export async function promoteSuperAdminAction(
  _prev: SuperAdminActionState,
  formData: FormData,
): Promise<SuperAdminActionState> {
  const session = await requirePlatformRole();
  const supabase = createServiceRoleClient();

  const lookup = await findProfileByEmail(supabase, String(formData.get("email") ?? ""));
  if (!lookup.ok) return { error: lookup.error };
  if (!lookup.profile) return { error: "No account with that email has signed in yet." };
  if (lookup.profile.platform_role === "super_admin") {
    return { success: `${lookup.profile.email} is already a super admin.` };
  }

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ platform_role: "super_admin" })
    .eq("id", lookup.profile.id);
  if (updateError) return { error: describeDatabaseError(updateError, "Couldn't promote that account.") };

  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: null,
    actor_id: session.userId,
    action: "platform.super_admin_promoted",
    target_type: "profile",
    target_id: lookup.profile.id,
    metadata: { email: lookup.profile.email },
  });
  if (auditError) {
    return { error: describeDatabaseError(auditError, "Promoted the account, but couldn't record the audit log entry.") };
  }

  revalidatePath(routes.platformSuperAdmins);
  return { success: `${lookup.profile.email} is now a super admin.` };
}

/**
 * Demotes a super_admin back to platform_role='user'. Blocked entirely by
 * checkSuperAdminDemotion (lib/platform/super-admins.ts) for self-demotion
 * and for the last remaining super_admin - both re-checked here against a
 * live count immediately before the write, never trusting anything the
 * client rendered a moment earlier.
 */
export async function demoteSuperAdminAction(
  _prev: SuperAdminActionState,
  formData: FormData,
): Promise<SuperAdminActionState> {
  const session = await requirePlatformRole();
  const targetUserId = String(formData.get("userId") ?? "").trim();
  if (!targetUserId) return { error: "Missing account." };

  const supabase = createServiceRoleClient();

  const { data: superAdmins, error: listError } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("platform_role", "super_admin");
  if (listError) return { error: describeDatabaseError(listError, "Couldn't count current super admins.") };

  const guard = checkSuperAdminDemotion({
    targetUserId,
    actingUserId: session.userId,
    totalSuperAdmins: (superAdmins ?? []).length,
  });
  if (!guard.allowed) return { error: guard.reason };

  const target = (superAdmins ?? []).find((p) => p.id === targetUserId);
  if (!target) return { error: "That account is not currently a super admin." };

  const { error: updateError } = await supabase.from("profiles").update({ platform_role: "user" }).eq("id", targetUserId);
  if (updateError) return { error: describeDatabaseError(updateError, "Couldn't demote that account.") };

  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: null,
    actor_id: session.userId,
    action: "platform.super_admin_demoted",
    target_type: "profile",
    target_id: targetUserId,
    metadata: { email: target.email },
  });
  if (auditError) {
    return { error: describeDatabaseError(auditError, "Demoted the account, but couldn't record the audit log entry.") };
  }

  revalidatePath(routes.platformSuperAdmins);
  return { success: `${target.email} is no longer a super admin.` };
}
