import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { DEVICE_COLUMNS, type DeviceRow } from "@/lib/devices/devices";
import { authenticateGateway, checkDeviceUsable, gatewayError, parseBody } from "@/lib/gateway/http";

const bodySchema = z.object({ tokenHash: z.string().regex(/^[0-9a-f]{64}$/, "tokenHash must be a lowercase hex SHA-256") });

/**
 * POST /api/gateway/device/resolve { tokenHash } -> { deviceId, userId, organizationId, displayName }.
 * The gateway turns the Host header's token into a hash and asks who it belongs to. Marks the device as seen.
 * (Contract: docs/superpowers/specs/2026-10-22-gateway-contract.md.)
 */
export async function POST(request: Request) {
  const denied = authenticateGateway(request);
  if (denied) return denied;

  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;

  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from("member_devices")
      .select(DEVICE_COLUMNS)
      .eq("token_hash", body.data.tokenHash)
      .maybeSingle();
    if (error) return gatewayError(500, "internal_error", "Could not look up the device.");
    if (!data) return gatewayError(404, "unknown_device", "This device is not registered.");
    const device = data as unknown as DeviceRow;

    const usable = await checkDeviceUsable(supabase, device);
    if (!usable.ok) return usable.response;

    const nowIso = new Date().toISOString();
    const { error: seenError } = await supabase
      .from("member_devices")
      .update({ last_seen_at: nowIso, ...(device.first_seen_at ? {} : { first_seen_at: nowIso }) })
      .eq("id", device.id);
    if (seenError) logger.warn("could not mark a device as seen", { deviceId: device.id, error: seenError.message });

    const { data: profile } = await supabase.from("profiles").select("display_name, email").eq("id", device.user_id).maybeSingle();
    const displayName = profile?.display_name?.trim() || profile?.email || "Printio user";

    return Response.json({
      deviceId: device.id,
      userId: device.user_id,
      organizationId: device.organization_id,
      displayName,
    });
  } catch (err) {
    logger.error("gateway device/resolve failed", { error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
