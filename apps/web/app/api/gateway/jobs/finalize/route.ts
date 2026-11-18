import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { createPrintJob, type CreatePrintJobResult } from "@/lib/jobs/create-print-job";
import { ippFileName, mapIppChoices } from "@/lib/gateway/ipp-choices";
import { authenticateGateway, gatewayError, jobMessage, loadUsableDevice, parseBody } from "@/lib/gateway/http";

/** Preflight and imposition of a large PDF can take a while; the default function limit is too tight. */
export const maxDuration = 60;

const INTAKE_PATH = /^gateway-intake\/([0-9a-f-]{36})\/[0-9a-zA-Z._-]{1,100}$/;

const bodySchema = z.object({
  deviceId: z.string().uuid(),
  storagePath: z.string().max(300).regex(INTAKE_PATH, "storagePath must be gateway-intake/<deviceId>/<file>"),
  fileName: z.string().max(300),
  sizeBytes: z.number().int().nonnegative(),
  ipp: z.object({
    jobName: z.string().max(1000).optional(),
    userAgent: z.string().max(1000).optional(),
    ippVersion: z.string().max(20).optional(),
    attributes: z.record(z.unknown()),
  }),
});

async function deleteIntake(supabase: ReturnType<typeof createServiceRoleClient>, path: string) {
  try {
    await supabase.storage.from(PRINT_JOBS_BUCKET).remove([path]);
  } catch (err) {
    logger.warn("could not delete a gateway intake object", { path, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/gateway/jobs/finalize - the gateway has uploaded a PDF to gateway-intake/<deviceId>/...; this turns it
 * into a normal print job for the device's member, through the same pipeline as the website
 * (lib/jobs/create-print-job.ts), then deletes the intake object.
 *
 * Never throws on odd input: what the print dialog asked for but we cannot honour becomes a HELD job with a readable
 * reason (lib/gateway/ipp-choices.ts); a file that is not a usable PDF is 422 bad_pdf and creates no job.
 * Intake objects are kept only when we answer 5xx, so the gateway can retry without re-uploading.
 */
export async function POST(request: Request) {
  const denied = authenticateGateway(request);
  if (denied) return denied;

  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const { deviceId, storagePath, fileName, ipp } = body.data;

  // The object must live under THIS device's folder: a gateway bug (or a leaked secret) cannot make us read
  // another device's upload, or any other object in the bucket.
  if (INTAKE_PATH.exec(storagePath)?.[1] !== deviceId) {
    return gatewayError(400, "invalid_request", "The upload does not belong to this device.");
  }

  const supabase = createServiceRoleClient();
  try {
    const lookup = await loadUsableDevice(supabase, deviceId);
    if (!lookup.ok) return lookup.response;
    const { device, member } = lookup;

    // The org's first active raw-mode printer profile (the default one first). Scoped to the DEVICE's organization.
    const { data: profile, error: profileError } = await supabase
      .from("printer_profiles")
      .select("id, printers!inner(organization_id), agents!inner(status)")
      .eq("printers.organization_id", member.organizationId)
      .eq("agents.status", "active")
      .eq("output_mode", "raw")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (profileError) return gatewayError(500, "internal_error", "Could not find a printer.");
    if (!profile) {
      return gatewayError(503, "no_printer", "No printer is ready to receive jobs from the print dialog yet. Ask your administrator.");
    }

    const { data: file, error: downloadError } = await supabase.storage.from(PRINT_JOBS_BUCKET).download(storagePath);
    if (downloadError || !file) return gatewayError(404, "intake_not_found", "The uploaded document could not be found.");
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { choices, heldReason, paperSize } = mapIppChoices(ipp.attributes);
    const name = ippFileName(ipp.jobName ?? fileName);
    const session = { userId: member.userId, membership: { organization_id: member.organizationId, role: member.role, department: member.department } };
    const run = (forcedHeldReason: string | undefined): Promise<CreatePrintJobResult> =>
      createPrintJob(supabase, session, bytes, name, {
        printerProfileId: profile.id,
        choices,
        colorMode: "bw",
        paperSize,
        punch: false,
        confirmBookletPadding: true,
        forcedHeldReason,
        source: "ipp",
        deviceId: device.id,
        ippUserAgent: ipp.userAgent,
      });

    let result = await run(heldReason ?? undefined);
    if (!result.ok && result.kind === "error" && result.code === "invalid_page_range") {
      // The dialog asked for pages this document does not have: keep the job, hold it, and say why.
      result = await run("The pages you chose in the print dialog could not be used.");
    }

    if (result.ok) {
      await deleteIntake(supabase, storagePath);
      const message = jobMessage({ status: result.status, heldReason: result.heldReason, policyReasons: result.policyReasons });
      return Response.json({ jobId: result.jobId, jobNumber: result.jobNumber, status: result.status, ...(message ? { message } : {}) });
    }

    if (result.kind === "needs_booklet_confirm") {
      // Cannot happen (this route never asks for a booklet); answer safely rather than crash.
      logger.error("gateway job unexpectedly needed booklet confirmation", { deviceId });
      return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
    }

    switch (result.code) {
      case "bad_pdf":
      case "too_large":
        await deleteIntake(supabase, storagePath);
        return gatewayError(422, "bad_pdf", result.error);
      case "quota_exceeded":
        await deleteIntake(supabase, storagePath);
        return gatewayError(403, "quota_exceeded", result.error);
      case "rate_limited":
        await deleteIntake(supabase, storagePath);
        return gatewayError(429, "rate_limited", result.error);
      case "printer_unavailable":
        return gatewayError(503, "no_printer", "No printer is ready to receive jobs from the print dialog yet. Ask your administrator.");
      default:
        // storage_failed / insert_failed / anything unforeseen: temporary from the sender's point of view.
        return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
    }
  } catch (err) {
    logger.error("gateway jobs/finalize failed", { deviceId, error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
