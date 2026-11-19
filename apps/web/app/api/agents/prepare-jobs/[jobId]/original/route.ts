import { apiError } from "@/lib/api-errors";
import { loadPrepareLease, ORIGINAL_URL_TTL_SECONDS, PRINT_JOBS_BUCKET, requirePrepareAgent } from "@/lib/prepare/prepare-jobs";

/** POST /api/agents/prepare-jobs/[jobId]/original: a short-lived signed download link for the job's own original file (lease required). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requirePrepareAgent(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const lease = await loadPrepareLease(db, agent, (await params).jobId);
  if (lease instanceof Response) return lease;

  const { data, error } = await db.storage.from(PRINT_JOBS_BUCKET).createSignedUrl(lease.sourcePath, ORIGINAL_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return apiError(500, "internal_error", "Failed to create a download link.");
  return Response.json({ url: data.signedUrl, expiresInSeconds: ORIGINAL_URL_TTL_SECONDS });
}
