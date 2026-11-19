import { apiError } from "@/lib/api-errors";
import { loadPrepareLease, PREPARE_LEASE_SECONDS, requirePrepareAgent } from "@/lib/prepare/prepare-jobs";

/** POST /api/agents/prepare-jobs/[jobId]/renew: extends the lease by another 120 s (a big PDF can take longer than one lease). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requirePrepareAgent(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const lease = await loadPrepareLease(db, agent, (await params).jobId);
  if (lease instanceof Response) return lease;

  const leaseUntil = new Date(Date.now() + PREPARE_LEASE_SECONDS * 1000).toISOString();
  const { data, error } = await db
    .from("server_jobs")
    .update({ lease_until: leaseUntil })
    .eq("id", lease.id)
    .eq("organization_id", agent.organizationId)
    .eq("claimed_by", agent.id)
    .eq("status", "claimed")
    .select("id")
    .maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to renew the lease.");
  if (!data) return apiError(409, "wrong_state", "The job is no longer yours to renew.");
  return Response.json({ leaseUntil });
}
