import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recoverExpiredLeasesForAgent } from "@/lib/lease-recovery";

/** The Agent processes jobs one at a time, so a longer list only costs a bigger response. */
const CLAIMABLE_LIMIT = 50;

/** See docs/agent-api.md. Jobs in `approved` status whose printer_profiles.agent_id
 *  is this agent, unclaimed or with an expired lease. */
export async function GET(request: Request) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");

  // A paused Agent is simply never offered work (agents.paused - see the
  // column comment in supabase/migrations/0022_*.sql). This is one of the two
  // server-side enforcement points for pausing; the other is the claim route,
  // which refuses even a job id an Agent already knows about. Deliberately an
  // empty list rather than an error: being paused is a normal administrative
  // state, not a fault, and the Agent's poll loop should treat it as "nothing
  // to do right now", not as a failure to back off from.
  if (agent.paused) return Response.json({ jobs: [] });

  const supabase = createServiceRoleClient();

  const { data: profiles } = await supabase.from("printer_profiles").select("id").eq("agent_id", agent.id);
  const profileIds = (profiles ?? []).map((p) => p.id);
  if (profileIds.length === 0) return Response.json({ jobs: [] });

  const nowIso = new Date().toISOString();
  const claimableQuery = supabase
    .from("print_jobs")
    .select("id, job_number, printer_profile_id, lease_expires_at")
    .eq("organization_id", agent.organizationId)
    .eq("status", "approved")
    .in("printer_profile_id", profileIds)
    // A job waiting out a "printer not available" backoff has lease_expires_at in the future (see the release
    // route), so this same filter hides it until its next attempt is due.
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
    // Fairness: oldest first (id breaks ties so the order is stable), so ten teachers sending at once are served
    // in the order they sent, and the Agent - which works through this list in order - keeps that order.
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(CLAIMABLE_LIMIT);

  // Self-healing: use the poll to recover THIS Agent's jobs whose lease expired (an Agent that crashed mid-print)
  // instead of waiting for the daily sweep. Throttled inside (at most once per ~5 minutes per agent per server
  // instance), never allowed to fail this call, and run alongside the list query instead of in front of it.
  const [{ data: jobs, error }] = await Promise.all([
    claimableQuery,
    recoverExpiredLeasesForAgent(supabase, {
      organizationId: agent.organizationId,
      agentId: agent.id,
      printerProfileIds: profileIds,
    }),
  ]);

  if (error) return apiError(500, "internal_error", "Failed to list claimable jobs.");

  return Response.json({
    jobs: (jobs ?? []).map((j) => ({ jobId: j.id, printerProfileId: j.printer_profile_id, jobNumber: j.job_number })),
  });
}
