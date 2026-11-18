"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { deleteDevice, resolveIssue, revokeDevice } from "@/lib/devices/devices";
import { setSetupConfirmed } from "@/lib/devices/setup-feedback-server";
import { routes } from "@/lib/routes";

export interface AdminRevokeState {
  error?: string;
  revokedId?: string;
}
export interface AdminDeleteState {
  error?: string;
  deletedId?: string;
}
export interface ResolveIssueState {
  error?: string;
  resolvedId?: string;
}

/** Turn off any device of the admin's organization. Admin only (RLS enforces it again). */
export async function adminRevokeDeviceAction(_prev: AdminRevokeState, formData: FormData): Promise<AdminRevokeState> {
  const session = await requireOrgRole(["org_admin"]);
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return { error: "Device not found." };
  const supabase = await createClient();
  const res = await revokeDevice(supabase, { deviceId, organizationId: session.membership.organization_id, userId: session.userId, asAdmin: true });
  if (!res.ok) return { error: res.error };
  revalidatePath(routes.adminDevices);
  return { revokedId: deviceId };
}

/**
 * Permanently delete any device of the admin's organization. Admin only: requireOrgRole runs first, and the delete
 * (service-role, since browser roles cannot delete) is scoped to the admin's own organization.
 */
export async function adminDeleteDeviceAction(_prev: AdminDeleteState, formData: FormData): Promise<AdminDeleteState> {
  const session = await requireOrgRole(["org_admin"]);
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return { error: "Device not found." };
  const res = await deleteDevice(createServiceRoleClient(), {
    deviceId,
    organizationId: session.membership.organization_id,
    userId: session.userId,
    asAdmin: true,
  });
  if (!res.ok) return { error: res.error };
  revalidatePath(routes.adminDevices);
  return { deletedId: deviceId };
}

export async function resolveIssueAction(_prev: ResolveIssueState, formData: FormData): Promise<ResolveIssueState> {
  const session = await requireOrgRole(["org_admin"]);
  const issueId = String(formData.get("issueId") ?? "");
  if (!issueId) return { error: "Item not found." };
  const supabase = await createClient();
  const res = await resolveIssue(supabase, {
    issueId,
    adminId: session.userId,
    organizationId: session.membership.organization_id,
    note: String(formData.get("note") ?? ""),
  });
  if (!res.ok) return { error: res.error };
  revalidatePath(routes.adminDevices);
  return { resolvedId: issueId };
}

export interface SetupConfirmState {
  error?: string;
  savedKey?: string;
}

/** Mark one exact setup "Confirmed working" for the organization, or take the mark off. Admin only. */
export async function setSetupConfirmedAction(_prev: SetupConfirmState, formData: FormData): Promise<SetupConfirmState> {
  const session = await requireOrgRole(["org_admin"]);
  const setupKey = String(formData.get("setupKey") ?? "");
  const supabase = await createClient();
  const res = await setSetupConfirmed(supabase, {
    organizationId: session.membership.organization_id,
    adminId: session.userId,
    setupKey,
    confirmed: formData.get("confirmed") === "1",
  });
  if (!res.ok) return { error: res.error };
  revalidatePath(routes.adminDevices);
  return { savedKey: setupKey };
}
