import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { DEVICE_COLUMNS, type DeviceRow } from "@/lib/devices/devices";
import { devicePrinterLabel } from "@/lib/devices/printer-label";
import { ensureMemberUserCode } from "@/lib/jobs/ensure-user-code";
import { authenticateGateway, checkDeviceUsable, gatewayError, parseBody } from "@/lib/gateway/http";

const bodySchema = z.object({ tokenHash: z.string().regex(/^[0-9a-f]{64}$/, "tokenHash must be a lowercase hex SHA-256") });

/**
 * POST /api/gateway/device/resolve { tokenHash } -> { deviceId, userId, organizationId, displayName, printerLabel }.
 * printerLabel is the name the device shows (Printio-<printer>-<user code>); best effort, left out if it cannot be built.
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

    let printerLabel: string | undefined;
    try {
      const [{ data: printer }, userCode] = await Promise.all([
        supabase.from("printers").select("name").eq("organization_id", device.organization_id).order("created_at", { ascending: true }).limit(1).maybeSingle(),
        ensureMemberUserCode(supabase, {
          organizationId: device.organization_id,
          userId: device.user_id,
          displayName: profile?.display_name ?? null,
          email: profile?.email ?? null,
        }),
      ]);
      printerLabel = devicePrinterLabel(printer?.name, userCode);
    } catch (labelError) {
      logger.warn("could not build the printer label", { deviceId: device.id, error: labelError instanceof Error ? labelError.message : String(labelError) });
    }

    return Response.json({
      deviceId: device.id,
      userId: device.user_id,
      organizationId: device.organization_id,
      displayName,
      deviceType: device.device_type,
      ...(printerLabel ? { printerLabel } : {}),
    });
  } catch (err) {
    logger.error("gateway device/resolve failed", { error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
