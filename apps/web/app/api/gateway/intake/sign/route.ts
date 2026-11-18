import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { authenticateGateway, gatewayError, loadUsableDevice, parseBody } from "@/lib/gateway/http";

const BUCKET = "print-jobs";
const INTAKE_PATH = /^gateway-intake\/([0-9a-f-]{36})\/[0-9a-zA-Z._-]{1,100}$/;

const bodySchema = z.object({
  storagePath: z.string().max(300).regex(INTAKE_PATH, "storagePath must be gateway-intake/<deviceId>/<file>"),
});

/**
 * POST /api/gateway/intake/sign { storagePath } -> { token }
 *
 * Lets the gateway upload one PDF to `gateway-intake/<deviceId>/<file>` WITHOUT holding the Supabase service-role key
 * (docs/TARGET-ARCHITECTURE.md phase D). The website mints a single-use signed upload token that is good for exactly
 * that path; the gateway hands it to Supabase Storage together with the bytes. The device in the path must exist and
 * be usable (not revoked, member still active), so a gateway can never open an upload slot for another folder.
 */
export async function POST(request: Request) {
  const denied = authenticateGateway(request);
  if (denied) return denied;

  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;

  const deviceId = INTAKE_PATH.exec(body.data.storagePath)?.[1];
  if (!deviceId) return gatewayError(400, "invalid_request", "storagePath must be gateway-intake/<deviceId>/<file>.");

  try {
    const supabase = createServiceRoleClient();
    const usable = await loadUsableDevice(supabase, deviceId);
    if (!usable.ok) return usable.response;

    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(body.data.storagePath);
    if (error || !data?.token) {
      logger.error("could not sign a gateway intake upload", { deviceId, error: error?.message ?? "no token returned" });
      return gatewayError(500, "internal_error", "Could not prepare the upload. Try again.");
    }
    return Response.json({ token: data.token });
  } catch (err) {
    logger.error("gateway intake/sign failed", { error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
