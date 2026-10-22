import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { adjustMonthlyUsage, usageAmountsForJob } from "@/lib/quota";
import { authenticateGateway, gatewayError, loadUsableDevice, parseBody } from "@/lib/gateway/http";

const bodySchema = z.object({ deviceId: z.string().uuid() });
const idSchema = z.string().uuid();

/** Only jobs that have not been handed to the Agent yet can be cancelled from the print dialog. */
const CANCELLABLE = ["held", "pending_approval", "approved"] as const;
/** These two already reserved quota at submission; held jobs reserve nothing. */
const RESERVED = new Set(["pending_approval", "approved"]);

/**
 * POST /api/gateway/jobs/<jobId>/cancel { deviceId } -> { status: "cancelled" }.
 * The job must be this device's. The status change is guarded on the status we read, so a job the Agent claims in
 * the meantime is not cancelled out from under it (409). A reserved quota is released, like every other path that
 * ends a job before it prints.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const denied = authenticateGateway(request);
  if (denied) return denied;

  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const { jobId } = await params;
  if (!idSchema.safeParse(jobId).success) return gatewayError(404, "unknown_job", "Job not found.");

  try {
    const supabase = createServiceRoleClient();
    const lookup = await loadUsableDevice(supabase, body.data.deviceId);
    if (!lookup.ok) return lookup.response;

    const { data: job, error } = await supabase
      .from("print_jobs")
      .select("id, status, organization_id, created_by, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode, is_test_print")
      .eq("id", jobId)
      .eq("device_id", lookup.device.id)
      .eq("source", "ipp")
      .maybeSingle();
    if (error) return gatewayError(500, "internal_error", "Could not look up the job.");
    if (!job) return gatewayError(404, "unknown_job", "Job not found.");

    if (!(CANCELLABLE as readonly string[]).includes(job.status)) {
      return gatewayError(409, "not_cancellable", "This job can no longer be cancelled.");
    }

    const { data: updated, error: updateError } = await supabase
      .from("print_jobs")
      .update({ status: "cancelled" })
      .eq("id", job.id)
      .eq("status", job.status)
      .select("id");
    if (updateError) return gatewayError(500, "internal_error", "Could not cancel the job.");
    if (!updated || updated.length === 0) return gatewayError(409, "not_cancellable", "This job can no longer be cancelled.");

    await supabase.from("print_job_events").insert({
      job_id: job.id,
      event_type: "JOB_CANCELLED",
      actor_type: "user",
      actor_id: job.created_by,
      metadata: { source: "ipp", deviceId: lookup.device.id, from: job.status },
    });

    if (RESERVED.has(job.status) && !job.is_test_print) {
      try {
        await adjustMonthlyUsage(
          supabase,
          { organizationId: job.organization_id, userId: job.created_by },
          usageAmountsForJob({
            organizationId: job.organization_id,
            userId: job.created_by,
            sourcePdfPages: job.source_pdf_pages,
            copies: job.copies,
            estimatedPrintedSides: job.estimated_printed_sides,
            estimatedPhysicalSheets: job.estimated_physical_sheets,
            colorMode: job.color_mode,
          }),
          "physical_sheets", // basis and limit are unused by the RPC's release path
          null,
          "release",
        );
      } catch (releaseError) {
        // The cancellation already committed; a reservation left behind only overstates this month's usage.
        logger.error("failed to release the quota reservation for a cancelled gateway job", {
          jobId: job.id,
          organizationId: job.organization_id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
    }

    return Response.json({ status: "cancelled" });
  } catch (err) {
    logger.error("gateway job cancel failed", { jobId, error: err instanceof Error ? err.message : String(err) });
    return gatewayError(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
