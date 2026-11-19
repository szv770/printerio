import { apiError } from "@/lib/api-errors";
import { loadPrepareLease, newPreparedPath, PRINT_JOBS_BUCKET, requirePrepareAgent } from "@/lib/prepare/prepare-jobs";

/**
 * POST /api/agents/prepare-jobs/[jobId]/upload-slot: a single-use signed upload token for ONE file in the job's own prepared
 * folder (`prepared/<organization>/<job>/<uuid>.pdf`). The server chooses the path; the print server only uploads to it with the
 * token (same pattern as the gateway's intake/sign route). Lease required.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requirePrepareAgent(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const lease = await loadPrepareLease(db, agent, (await params).jobId);
  if (lease instanceof Response) return lease;

  const path = newPreparedPath(lease.organizationId, lease.id);
  const { data, error } = await db.storage.from(PRINT_JOBS_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.token) return apiError(500, "internal_error", "Failed to prepare the upload.");
  return Response.json({ path, token: data.token });
}
