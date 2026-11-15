import { z } from "zod";
import { apiError } from "@/lib/api-errors";
import { loadLeasedJob, MAX_ERROR_CHARS, readJsonBody, requireLibraryFetcher } from "@/lib/library/server-jobs";

const bodySchema = z.object({ error: z.string().max(5000).optional() }).strict();

/** See docs/agent-api.md. The lease holder reports that it could not get the page. Only a short error text is kept (it can be shown to people). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requireLibraryFetcher(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const { jobId } = await params;

  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return apiError(400, "invalid_body", "The body must be { error?: string }.");

  const job = await loadLeasedJob(db, agent, jobId);
  if (job instanceof Response) return job;

  const text = (body.data.error ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
  const { data: closed, error } = await db
    .from("server_jobs")
    .update({ status: "failed", error: text || "The print server could not get that page.", lease_until: null, updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "claimed")
    .eq("claimed_by", agent.id)
    .select("id")
    .maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to record the failure.");
  if (!closed) return apiError(409, "wrong_state", "The job is no longer yours to fail.");
  return Response.json({ ok: true });
}
