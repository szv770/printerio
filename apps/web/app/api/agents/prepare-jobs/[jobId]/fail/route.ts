import { z } from "zod";
import { apiError } from "@/lib/api-errors";
import { loadPrepareLease, MAX_REASON_CHARS, readJsonBody, requirePrepareAgent } from "@/lib/prepare/prepare-jobs";

const bodySchema = z.object({ reason: z.string().trim().min(1).max(MAX_REASON_CHARS) }).strict();

/**
 * POST /api/agents/prepare-jobs/[jobId]/fail { reason }: the print server could not prepare the file (broken PDF, too big, took too long).
 * The plain-language reason is kept on the job so the sender sees it. Lease required.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requirePrepareAgent(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const lease = await loadPrepareLease(db, agent, (await params).jobId);
  if (lease instanceof Response) return lease;

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid_request", "A short plain reason is required.");

  const { data, error } = await db
    .from("server_jobs")
    .update({ status: "failed", error: parsed.data.reason, lease_until: null, finished_at: new Date().toISOString() })
    .eq("id", lease.id)
    .eq("organization_id", agent.organizationId)
    .eq("claimed_by", agent.id)
    .eq("status", "claimed")
    .select("id")
    .maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to record the failure.");
  if (!data) return apiError(409, "wrong_state", "The job is no longer in progress.");
  return Response.json({ ok: true });
}
