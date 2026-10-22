"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { getGatewayEnv } from "@/lib/env";
import { createDevice, revokeDevice } from "@/lib/devices/devices";
import { deviceAddress } from "@/lib/devices/present";
import { routes } from "@/lib/routes";

export interface AddDeviceState {
  error?: string;
  fieldErrors?: { name?: string; deviceType?: string };
  /** Returned once, right after creation. The raw token only exists inside this address and is never stored. */
  created?: { deviceId: string; name: string; deviceType: string; hostname: string; url: string };
}

export interface RevokeDeviceState {
  error?: string;
  revokedId?: string;
}

export async function addDeviceAction(_prev: AddDeviceState, formData: FormData): Promise<AddDeviceState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "Your account is not part of an organization yet." };

  const name = String(formData.get("name") ?? "");
  const deviceType = String(formData.get("deviceType") ?? "");

  const supabase = await createClient();
  const res = await createDevice(supabase, {
    organizationId: session.membership.organization_id,
    userId: session.userId,
    name,
    deviceType,
    baseDomain: getGatewayEnv().baseDomain,
  });
  if (!res.ok) {
    if (/name/i.test(res.error)) return { error: res.error, fieldErrors: { name: res.error } };
    if (/kind of device/i.test(res.error)) return { error: res.error, fieldErrors: { deviceType: res.error } };
    return { error: res.error };
  }

  revalidatePath(routes.devices);
  const addr = deviceAddress(res.hostname);
  return { created: { deviceId: res.device.id, name: res.device.name, deviceType: res.device.device_type, ...addr } };
}

export async function revokeDeviceAction(_prev: RevokeDeviceState, formData: FormData): Promise<RevokeDeviceState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "Your account is not part of an organization yet." };
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return { error: "Device not found." };

  const supabase = await createClient();
  const res = await revokeDevice(supabase, { deviceId, organizationId: session.membership.organization_id, userId: session.userId });
  if (!res.ok) return { error: res.error };
  revalidatePath(routes.devices);
  return { revokedId: deviceId };
}
