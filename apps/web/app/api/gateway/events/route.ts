import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { DEVICE_EVENT_TYPES, recordDeviceEvent } from "@/lib/devices/devices";
import { authenticateGateway, gatewayError, loadUsableDevice, parseBody } from "@/lib/gateway/http";

const bodySchema = z.object({
  deviceId: z.string().uuid(),
  type: z.enum(DEVICE_EVENT_TYPES),
  userAgent: z.string().max(1000).optional(),
  detail: z.record(z.unknown()).optional(),
});

/** Keeps a device's `detail` blob small: the gateway's own bookkeeping, never a place for documents. */
const MAX_DETAIL_BYTES = 4000;

/**
 * POST /api/gateway/events { deviceId, type, userAgent?, detail? } -> 204.
 * Appends to device_events and updates last_seen_at / last_user_agent / first_job_at.
 */
export async function POST(request: Request) {
  const denied = authenticateGateway(request);
  if (denied) return denied;

  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;

  try {
    const supabase = createServiceRoleClient();
    const device = await loadUsableDevice(supabase, body.data.deviceId);
    if (!device.ok) return device.response;

    const detail = body.data.detail && JSON.stringify(body.data.detail).length <= MAX_DETAIL_BYTES ? body.data.detail : undefined;
    const recorded = await recordDeviceEvent(supabase, {
      deviceId: device.device.id,
      type: body.data.type,
      userAgent: body.data.userAgent,
      detail,
    });
    if (!recorded) logger.warn("could not record a device event", { deviceId: device.device.id, type: body.data.type });
    // Events are bookkeeping: the gateway must never fail a print over one.
    return new Response(null, { status: 204 });
  } catch (err) {
    logger.error("gateway events failed", { error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
