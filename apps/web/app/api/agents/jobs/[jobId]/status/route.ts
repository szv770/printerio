import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { adjustMonthlyUsage, usageAmountsForJob } from "@/lib/quota";
import { canTransition, type JobState } from "@printio/shared";
import { isAutoRetryEnabled, requeueFailedJob } from "@/lib/jobs/lifecycle";
import { logger } from "@/lib/logger";
import type { TablesUpdate } from "@/lib/database.types";

const REPORTABLE_STATUSES: JobState[] = ["downloaded", "printing", "submitted_to_spooler", "completed", "failed"];

const EVENT_FOR_STATUS: Partial<Record<JobState, string>> = {
  downloaded: "DOWNLOAD_COMPLETED",
  printing: "PRINT_SUBMITTED",
  submitted_to_spooler: "SPOOLER_ACCEPTED",
  completed: "JOB_COMPLETED",
  failed: "PRINT_FAILED",
};

interface StatusBody {
  status?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

/** See docs/agent-api.md. Requires an active lease held by this agent. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  const { jobId } = await params;

  let body: StatusBody;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  const newStatus = body.status as JobState;
  if (!REPORTABLE_STATUSES.includes(newStatus)) {
    return apiError(400, "invalid_status", `status must be one of: ${REPORTABLE_STATUSES.join(", ")}`);
  }

  const supabase = createServiceRoleClient();
  const { data: job } = await supabase.from("print_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job || job.organization_id !== agent.organizationId) return apiError(404, "not_found", "Job not found.");
  if (job.lease_owner_agent_id !== agent.id) return apiError(403, "no_lease", "You do not hold the lease on this job.");

  if (!canTransition(job.status as JobState, newStatus)) {
    return apiError(409, "illegal_transition", `Cannot transition from '${job.status}' to '${newStatus}'.`);
  }

  const update: TablesUpdate<"print_jobs"> = { status: newStatus };
  if (body.message) update.error_message = newStatus === "failed" ? body.message : null;
  if (newStatus === "completed") update.completed_at = new Date().toISOString();
  if (newStatus === "failed") update.attempt_count = job.attempt_count + 1;

  // Conditional on the status we just validated: two overlapping reports (an agent retrying after a timeout)
  // cannot both win, so quota is consumed / released at most once per transition.
  const { data: updatedRows, error: updateError } = await supabase
    .from("print_jobs")
    .update(update)
    .eq("id", jobId)
    .eq("status", job.status)
    .select("id");
  if (updateError) return apiError(500, "internal_error", "Failed to update job status.");
  if (!updatedRows || updatedRows.length === 0) {
    return apiError(409, "illegal_transition", `Job is no longer '${job.status}'.`);
  }

  await supabase.from("print_job_events").insert({
    job_id: jobId,
    event_type: EVENT_FOR_STATUS[newStatus] ?? "JOB_COMPLETED",
    actor_type: "agent",
    actor_id: agent.id,
    metadata: { message: body.message ?? null, ...body.metadata },
  });

  // Convert the submission-time reservation into recorded usage (completed),
  // or release it once retries are exhausted (failed for good) - see
  // docs/architecture.md sec 14.
  //
  // An admin test print reserved nothing at creation (it never runs the
  // policy/quota path - see app/admin/printers/actions.ts), so it must not
  // touch monthly_usage at all here. This is not just a tidiness point:
  // 'consume' would add sheets nobody requested to that admin's recorded
  // usage AND subtract from their reserved counters, silently eating a
  // reservation belonging to one of their real, still-pending jobs
  // (adjust_monthly_usage works on the shared per-user row, not per job).
  if (job.is_test_print) return Response.json({ ok: true });

  const amounts = usageAmountsForJob({
    organizationId: job.organization_id,
    userId: job.created_by,
    sourcePdfPages: job.source_pdf_pages,
    copies: job.copies,
    estimatedPrintedSides: job.estimated_printed_sides,
    estimatedPhysicalSheets: job.estimated_physical_sheets,
    colorMode: job.color_mode,
  });
  const quotaCtx = { organizationId: job.organization_id, userId: job.created_by };
  // The status change above already committed, so a quota hiccup must not turn into a 500 (the agent would retry
  // and only get a 409 back): log it loudly instead.
  const adjustQuota = async (mode: "consume" | "release") => {
    try {
      await adjustMonthlyUsage(supabase, quotaCtx, amounts, "physical_sheets", null, mode);
    } catch (err) {
      logger.error("quota adjustment failed after a job status change", {
        jobId,
        mode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (newStatus === "completed") {
    await adjustQuota("consume");
  } else if (newStatus === "failed") {
    const attemptsUsed = job.attempt_count + 1;
    if (attemptsUsed >= job.max_attempts) {
      // Finally abandoned: release the reservation (exactly once - this branch only runs for the request that won
      // the conditional update above).
      await adjustQuota("release");
    } else if (await isAutoRetryEnabled(supabase, job.organization_id)) {
      // Keep the reservation and re-queue; the job is claimed again by the normal loop.
      const queued = await requeueFailedJob(supabase, { ...job, attempt_count: attemptsUsed }, { type: "system" });
      return Response.json({ ok: true, retryScheduled: queued });
    }
    // Otherwise it stays failed with its reservation while it can still be retried (owner "Try again", or cancel).
  }

  return Response.json({ ok: true });
}
