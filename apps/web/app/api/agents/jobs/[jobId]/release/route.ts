import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { planRelease, type WaitingKind } from "@printio/shared";
import { waitingWindowMs } from "@/lib/jobs/waiting-window";

/**
 * POST /api/agents/jobs/:jobId/release  { kind: "unavailable" | "unknown" }
 *
 * The Agent could not hand the document to the printer (raw port refused / timed out / stalled, or the cause is
 * unknown). That is NOT a failed print: the printer may be off, jammed or being reloaded and will take the job
 * when it is back. So the job goes back to the queue (claimed -> approved, an existing legal transition) with its
 * next attempt hidden behind an exponential backoff (`lease_expires_at` in the future - the claimable/claim filter
 * already honours it), a plain reason stored in `error_message` behind a stable marker (see
 * packages/shared/src/waiting.ts), and WITHOUT using up `attempt_count` or releasing the quota reservation.
 * Only when the job has been unprintable for the whole window (default 2 hours, PRINTIO_WAITING_WINDOW_MINUTES)
 * does it become `failed` (with its attempts and reservation intact, so "Try again" works; never auto-requeued).
 *
 * Only a job that is still `claimed` and leased to THIS agent can be released: once it is downloading/printing
 * some bytes may be at the printer, and the database's transition rule does not allow going back.
 * All writes use the service-role client after the explicit checks below (the existing pattern for agent routes).
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  const { jobId } = await params;

  let body: { kind?: unknown; detail?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  if (body?.kind !== "unavailable" && body?.kind !== "unknown") {
    return apiError(400, "invalid_kind", "kind must be 'unavailable' or 'unknown'.");
  }
  const kind: WaitingKind = body.kind;
  const detail = typeof body.detail === "string" ? body.detail.slice(0, 300) : null;

  const supabase = createServiceRoleClient();
  const { data: job } = await supabase
    .from("print_jobs")
    .select("id, organization_id, status, lease_owner_agent_id, error_message")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.organization_id !== agent.organizationId) return apiError(404, "not_found", "Job not found.");
  if (job.lease_owner_agent_id !== agent.id) return apiError(403, "no_lease", "You do not hold the lease on this job.");
  if (job.status !== "claimed") {
    return apiError(409, "wrong_state", `Job is in state '${job.status}'; only a claimed job can be released.`);
  }

  const now = Date.now();
  const plan = planRelease({ previous: job.error_message, now, windowMs: waitingWindowMs(), kind });

  if (plan.action === "fail") {
    // Conditional on the exact state we decided from: a second overlapping release (or the sweep) matches 0 rows.
    const { data: failedRows, error } = await supabase
      .from("print_jobs")
      .update({ status: "failed", error_message: plan.message })
      .eq("id", jobId)
      .eq("status", "claimed")
      .eq("lease_owner_agent_id", agent.id)
      .select("id");
    if (error) return apiError(500, "internal_error", "Failed to update the job.");
    if (!failedRows || failedRows.length === 0) return apiError(409, "wrong_state", "Job is no longer claimed.");
    await supabase.from("print_job_events").insert({
      job_id: jobId,
      event_type: "PRINT_FAILED",
      actor_type: "agent",
      actor_id: agent.id,
      metadata: { message: plan.message, gaveUp: true, kind },
    });
    // attempt_count is deliberately not incremented and the quota reservation is kept: the owner's "Try again"
    // (or "Cancel", which releases it) decides what happens next.
    return Response.json({ ok: true, outcome: "failed" });
  }

  const retryAtIso = new Date(plan.retryAt).toISOString();
  const { data: rows, error } = await supabase
    .from("print_jobs")
    .update({ status: "approved", lease_owner_agent_id: null, lease_expires_at: retryAtIso, error_message: plan.message })
    .eq("id", jobId)
    .eq("status", "claimed")
    .eq("lease_owner_agent_id", agent.id)
    .select("id");
  if (error) return apiError(500, "internal_error", "Failed to release the job.");
  if (!rows || rows.length === 0) return apiError(409, "wrong_state", "Job is no longer claimed.");

  // One history line when the job FIRST starts waiting (later retries would only add noise: the job page already
  // shows the reason and the marker holds the counters).
  if (plan.tries === 1) {
    await supabase.from("print_job_events").insert({
      job_id: jobId,
      event_type: "RETRY_SCHEDULED",
      actor_type: "agent",
      actor_id: agent.id,
      metadata: { waiting: true, kind, retryAt: retryAtIso, detail },
    });
  }
  logger.info("job released back to the queue (printer not available)", { jobId, kind, tries: plan.tries, retryAt: retryAtIso });
  return Response.json({ ok: true, outcome: "waiting", tries: plan.tries, retryAt: retryAtIso });
}
