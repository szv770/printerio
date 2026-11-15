import { requireLibraryFetcher, JOB_LEASE_SECONDS } from "@/lib/library/server-jobs";
import { apiError } from "@/lib/api-errors";

/** A lost race (another agent took the job between our look and our update) is retried with the next-oldest job this many times. */
const CLAIM_ATTEMPTS = 3;

/**
 * See docs/agent-api.md. Hands the calling library-fetcher agent the oldest waiting job (queued, or claimed with an expired
 * lease) and leases it for 120 seconds. Atomic the same way the print-job claim is: ONE conditional UPDATE decides the
 * winner, so two agents can never both get a job. The answer carries structured params only (never an address): the agent
 * builds the address itself from the shared allow-list.
 */
export async function POST(request: Request) {
  const guard = await requireLibraryFetcher(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const nowIso = new Date().toISOString();
    const { data: candidate, error } = await db
      .from("server_jobs")
      .select("id, kind, params, status")
      .or(`status.eq.queued,and(status.eq.claimed,lease_until.lt.${nowIso})`)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return apiError(500, "internal_error", "Failed to look for a job.");
    if (!candidate) return new Response(null, { status: 204 });

    // The update names the exact state we saw: a job somebody else just took no longer matches.
    let update = db
      .from("server_jobs")
      .update({
        status: "claimed",
        claimed_by: agent.id,
        lease_until: new Date(Date.now() + JOB_LEASE_SECONDS * 1000).toISOString(),
        error: null,
      })
      .eq("id", candidate.id)
      .eq("status", candidate.status);
    if (candidate.status === "claimed") update = update.lt("lease_until", nowIso);
    const { data: claimed, error: updateError } = await update.select("id").maybeSingle();
    if (updateError) return apiError(500, "internal_error", "Failed to claim the job.");
    if (claimed) return Response.json({ jobId: candidate.id, kind: candidate.kind, params: candidate.params });
  }
  return new Response(null, { status: 204 });
}
