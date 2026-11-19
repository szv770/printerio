import { apiError } from "@/lib/api-errors";
import { PREPARE_KIND, PREPARE_LEASE_SECONDS, PREPARE_QUEUE_EXPIRY_MS, requirePrepareAgent } from "@/lib/prepare/prepare-jobs";

/** A lost race (another server of the same school took the job between our look and our update) is retried with the next-oldest job. */
const CLAIM_ATTEMPTS = 3;

/**
 * POST /api/agents/prepare-jobs/claim (docs/PREPARE-JOBS-DESIGN.md). Hands the calling print server the oldest waiting prepare
 * job OF ITS OWN ORGANIZATION (queued, or claimed with an expired lease) and leases it for 120 s. Atomic the same way the print-job
 * claim is: ONE conditional UPDATE decides the winner. Queued jobs older than 24 hours expire first. A paused server gets nothing.
 * The answer carries the structured params only: the file itself is fetched with `original`.
 */
export async function POST(request: Request) {
  const guard = await requirePrepareAgent(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  if (agent.paused) return new Response(null, { status: 204 });

  // Give up on old waiting jobs of THIS organization only. A failure here must not stop a claim.
  await db
    .from("server_jobs")
    .update({ status: "failed", error: "expired", lease_until: null, finished_at: new Date().toISOString() })
    .eq("kind", PREPARE_KIND)
    .eq("organization_id", agent.organizationId)
    .eq("status", "queued")
    .lt("created_at", new Date(Date.now() - PREPARE_QUEUE_EXPIRY_MS).toISOString());

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const nowIso = new Date().toISOString();
    const { data: candidate, error } = await db
      .from("server_jobs")
      .select("id, params, status")
      .eq("kind", PREPARE_KIND)
      .eq("organization_id", agent.organizationId)
      .or(`status.eq.queued,and(status.eq.claimed,lease_until.lt.${nowIso})`)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return apiError(500, "internal_error", "Failed to look for a job.");
    if (!candidate) return new Response(null, { status: 204 });

    let update = db
      .from("server_jobs")
      .update({
        status: "claimed",
        claimed_by: agent.id,
        lease_until: new Date(Date.now() + PREPARE_LEASE_SECONDS * 1000).toISOString(),
        error: null,
      })
      .eq("id", candidate.id)
      .eq("organization_id", agent.organizationId)
      .eq("status", candidate.status);
    if (candidate.status === "claimed") update = update.lt("lease_until", nowIso);
    const { data: claimed, error: updateError } = await update.select("id").maybeSingle();
    if (updateError) return apiError(500, "internal_error", "Failed to claim the job.");
    if (claimed) return Response.json({ jobId: candidate.id, params: candidate.params, leaseSeconds: PREPARE_LEASE_SECONDS });
  }
  return new Response(null, { status: 204 });
}
