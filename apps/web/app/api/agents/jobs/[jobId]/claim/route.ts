import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Atomic claim (docs/architecture.md sec 13, docs/agent-api.md). A single
 * UPDATE ... WHERE status='approved' AND (unleased OR lease-expired) is
 * race-safe against duplicate claims (Agent restart, reconnect, cloud retry) -
 * Postgres serializes concurrent UPDATEs to the same row, so only one caller
 * ever observes a matched row.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  const { jobId } = await params;

  const supabase = createServiceRoleClient();

  const { data: job } = await supabase
    .from("print_jobs")
    .select("id, organization_id, printer_profile_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.organization_id !== agent.organizationId) {
    return apiError(404, "not_found", "Job not found.");
  }
  if (!job.printer_profile_id) return apiError(409, "no_profile", "Job has no printer profile assigned.");

  const { data: profile } = await supabase
    .from("printer_profiles")
    .select("agent_id")
    .eq("id", job.printer_profile_id)
    .maybeSingle();
  if (!profile || profile.agent_id !== agent.id) {
    return apiError(403, "wrong_agent", "This job is not assigned to your agent.");
  }

  const { data: settings } = await supabase
    .from("organization_settings")
    .select("job_lease_minutes")
    .eq("organization_id", agent.organizationId)
    .single();
  const leaseMinutes = settings?.job_lease_minutes ?? 10;
  const nowIso = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseMinutes * 60_000).toISOString();

  const { data: claimed, error } = await supabase
    .from("print_jobs")
    .update({ status: "claimed", lease_owner_agent_id: agent.id, lease_expires_at: leaseExpiresAt })
    .eq("id", jobId)
    .eq("status", "approved")
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
    .select("id")
    .maybeSingle();

  if (error) return apiError(500, "internal_error", "Failed to claim job.");
  if (!claimed) return apiError(409, "already_claimed", "Job was already claimed by another agent.");

  await supabase.from("print_job_events").insert({
    job_id: jobId,
    event_type: "AGENT_CLAIMED",
    actor_type: "agent",
    actor_id: agent.id,
    metadata: {},
  });

  return Response.json({ ok: true, leaseExpiresAt });
}
