"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import type { OrgRole } from "@printos/shared";

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
  if (error) return { error: error.message };

  revalidatePath(routes.adminUsers);
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
  if (error) return { error: error.message };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "member.role_changed",
    target_type: "organization_members",
    target_id: userId,
    metadata: { role },
  });

  revalidatePath(routes.adminUsers);
  return {};
}
