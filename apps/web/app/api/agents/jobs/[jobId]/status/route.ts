import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { adjustMonthlyUsage } from "@/lib/quota";
import { canTransition, type JobState } from "@printos/shared";
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

  const { error: updateError } = await supabase.from("print_jobs").update(update).eq("id", jobId);
  if (updateError) return apiError(500, "internal_error", "Failed to update job status.");

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
  const colorWeight = job.color_mode === "color" ? 2 : 1;
  const amounts = {
    pdfPages: job.source_pdf_pages * job.copies,
    printedSides: job.estimated_printed_sides,
    physicalSheets: job.estimated_physical_sheets,
    colorWeighted: job.estimated_physical_sheets * colorWeight,
  };
  if (newStatus === "completed") {
    await adjustMonthlyUsage(supabase, { organizationId: job.organization_id, userId: job.created_by }, amounts, "physical_sheets", null, "consume");
  } else if (newStatus === "failed" && job.attempt_count + 1 >= job.max_attempts) {
    await adjustMonthlyUsage(supabase, { organizationId: job.organization_id, userId: job.created_by }, amounts, "physical_sheets", null, "release");
  }

  return Response.json({ ok: true });
}
