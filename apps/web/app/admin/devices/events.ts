"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { listEventsForDevice } from "@/lib/devices/devices";

export interface DeviceEventItem {
  id: string;
  type: string;
  user_agent: string | null;
  detail: string;
  created_at: string;
}

/** Loads a device's recent gateway events when an admin expands it. Admin only; RLS scopes the rows to the org. */
export async function loadDeviceEventsAction(deviceId: string): Promise<{ events?: DeviceEventItem[]; error?: string }> {
  await requireOrgRole(["org_admin"]);
  if (!deviceId) return { error: "Device not found." };
  try {
    const supabase = await createClient();
    const rows = await listEventsForDevice(supabase, deviceId, 30);
    return {
      events: rows.map((r) => ({
        id: r.id,
        type: r.type,
        user_agent: r.user_agent,
        detail: r.detail && Object.keys(r.detail as object).length > 0 ? JSON.stringify(r.detail) : "",
        created_at: r.created_at,
      })),
    };
  } catch {
    return { error: "Could not load what this device sent. Try again." };
  }
}
