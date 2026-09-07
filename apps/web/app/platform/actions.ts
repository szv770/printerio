"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";

export interface PlatformActionState {
  error?: string;
  success?: string;
}
const initial: PlatformActionState = {};
export { initial as initialPlatformActionState };

/**
 * "Join organization as admin" (docs/architecture.md sec 2.1: a super_admin's
 * org-scoped access must be explicit and audit-logged, never implicit RLS
 * access). Runs entirely on the service-role client - the acting super_admin
 * has no existing membership in this organization yet, so their own
 * RLS-governed session could not insert the organization_members row itself
 * (organization_members' insert policy requires private.is_org_admin(), which
 * is exactly the row this call is creating) - this is the
 * "cross-tenant super-admin provisioning" case lib/supabase/service-role.ts's
 * doc comment names explicitly.
 *
 * A no-op (reported as such, not silently ignored) if the acting super_admin
 * is already a member - never inserts a second row or demotes an existing
 * higher-touch membership.
 */
export async function joinOrganizationAsAdminAction(
  _prev: PlatformActionState,
  formData: FormData,
): Promise<PlatformActionState> {
  const session = await requirePlatformRole();
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  if (!organizationId) return { error: "Missing organization." };

  const supabase = createServiceRoleClient();

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError) return { error: describeDatabaseError(orgError, "Couldn't look up that organization.") };
  if (!org) return { error: "Organization not found." };

  const { data: existing, error: existingError } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (existingError) {
    return { error: describeDatabaseError(existingError, "Couldn't check your existing membership.") };
  }
  if (existing) {
    return { success: `Already a member of ${org.name} (role: ${existing.role}).` };
  }

  const { error: insertError } = await supabase.from("organization_members").insert({
    organization_id: organizationId,
    user_id: session.userId,
    role: "org_admin",
    status: "active",
  });
  if (insertError) return { error: describeDatabaseError(insertError, "Couldn't join that organization.") };

  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: session.userId,
    action: "platform.super_admin_joined_organization",
    target_type: "organization",
    target_id: organizationId,
    metadata: { role: "org_admin" },
  });
  if (auditError) return { error: describeDatabaseError(auditError, "Joined the organization, but couldn't record the audit log entry.") };

  revalidatePath(routes.platform);
  return { success: `Joined ${org.name} as org_admin.` };
}
