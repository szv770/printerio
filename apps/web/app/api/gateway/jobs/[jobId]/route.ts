import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { gatewayStatusOfPrepare, loadGatewayPrepareJob } from "@/lib/prepare/gateway";
import { authenticateGateway, gatewayError, jobMessage, jobWaitingKind } from "@/lib/gateway/http";

const idSchema = z.string().uuid();

/**
 * GET /api/gateway/jobs/<jobId>?deviceId=<id> -> { jobId, status, message? }.
 * 404 when the job is not that device's (so a device can never read another device's or the website's jobs).
 * A revoked device can still read the state of jobs it already sent.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const denied = authenticateGateway(request);
  if (denied) return denied;

  const { jobId } = await params;
  const deviceId = new URL(request.url).searchParams.get("deviceId");
  if (!idSchema.safeParse(deviceId).success) return gatewayError(400, "invalid_request", "deviceId is required.");
  if (!idSchema.safeParse(jobId).success) return gatewayError(404, "unknown_job", "Job not found.");

  try {
    const supabase = createServiceRoleClient();
    const { data: job, error } = await supabase
      .from("print_jobs")
      .select("id, status, held_reason, policy_reasons, error_message")
      .eq("id", jobId)
      .eq("device_id", deviceId as string)
      .eq("source", "ipp")
      .maybeSingle();
    if (error) return gatewayError(500, "internal_error", "Could not look up the job.");
    if (!job) {
      // No print job yet: it may still be being prepared by the print server (same id), or it never existed.
      const preparing = await loadGatewayPrepareJob(supabase, jobId, deviceId as string);
      const view = preparing ? gatewayStatusOfPrepare(preparing) : null;
      if (view) return Response.json({ jobId, status: view.status, ...(view.message ? { message: view.message } : {}) });
      if (!preparing) return gatewayError(404, "unknown_job", "Job not found.");
      // The print job was created between the two reads: read it again.
      const { data: created } = await supabase
        .from("print_jobs")
        .select("id, status, held_reason, policy_reasons, error_message")
        .eq("id", jobId)
        .eq("device_id", deviceId as string)
        .eq("source", "ipp")
        .maybeSingle();
      if (!created) return Response.json({ jobId, status: "draft" });
      const createdMessage = jobMessage({ status: created.status, heldReason: created.held_reason, policyReasons: created.policy_reasons, errorMessage: created.error_message });
      const createdWaiting = jobWaitingKind({ status: created.status, errorMessage: created.error_message });
      return Response.json({ jobId: created.id, status: created.status, ...(createdMessage ? { message: createdMessage } : {}), ...(createdWaiting ? { waiting: createdWaiting } : {}) });
    }

    const message = jobMessage({
      status: job.status,
      heldReason: job.held_reason,
      policyReasons: job.policy_reasons,
      errorMessage: job.error_message,
    });
    // `waiting` is set only while a queued job is waiting for the printer (the phone then says so in plain words).
    const waiting = jobWaitingKind({ status: job.status, errorMessage: job.error_message });
    return Response.json({ jobId: job.id, status: job.status, ...(message ? { message } : {}), ...(waiting ? { waiting } : {}) });
  } catch (err) {
    logger.error("gateway job status failed", { jobId, error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
