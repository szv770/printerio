import { apiError } from "@/lib/api-errors";
import { loadPrepareLease, prepareResultSchema, preparedFolder, readJsonBody, requirePrepareAgent } from "@/lib/prepare/prepare-jobs";

/**
 * POST /api/agents/prepare-jobs/[jobId]/complete { result }: the print server finished preparing. The result is stored on the job and
 * the job is marked done. (Creating the print job from the result is the next step, P2; nothing here prints anything.) A prepared
 * path must be inside this job's own folder. A job the sender cancelled answers 409 `cancelled` and the work is discarded.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requirePrepareAgent(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const lease = await loadPrepareLease(db, agent, (await params).jobId);
  if (lease instanceof Response) return lease;

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = prepareResultSchema.safeParse((body as { result?: unknown } | null)?.result);
  if (!parsed.success) return apiError(400, "invalid_request", "The result is not in the expected shape.");
  const result = parsed.data;
  if (result.preparedPath !== null && !result.preparedPath.startsWith(preparedFolder(lease.organizationId, lease.id))) {
    return apiError(400, "invalid_request", "The prepared file is not in this job's own folder.");
  }

  const { data, error } = await db
    .from("server_jobs")
    .update({ status: "done", result, error: null, lease_until: null, finished_at: new Date().toISOString() })
    .eq("id", lease.id)
    .eq("organization_id", agent.organizationId)
    .eq("claimed_by", agent.id)
    .eq("status", "claimed")
    .select("id")
    .maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to store the result.");
  // The status changed between our check and the update (for example the sender cancelled): the work must be discarded.
  if (!data) return apiError(409, "wrong_state", "The job is no longer in progress. Discard your work.");
  return Response.json({ ok: true });
}
