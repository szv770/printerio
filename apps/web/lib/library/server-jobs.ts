import "server-only";
import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest, type AuthenticatedAgent } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

/** How long a print server holds a job before another may take it over (it must complete or fail within this). */
export const JOB_LEASE_SECONDS = 120;
/** Biggest request body the complete endpoint reads (a payload may be up to ~1.3 MB; this leaves room for the envelope). */
export const MAX_BODY_BYTES = 1_600_000;
/** Longest error text kept on a failed job. */
export const MAX_ERROR_CHARS = 300;

type Db = ReturnType<typeof createServiceRoleClient>;

/**
 * The guard for every server-jobs endpoint: a valid agent bearer credential (401 otherwise) that is registered in
 * `library_fetchers` (403 otherwise). Being an active agent of some school is NOT enough: the shared cache that every
 * school reads may only be filled by the print servers the owner registered by hand.
 */
export async function requireLibraryFetcher(request: Request): Promise<{ agent: AuthenticatedAgent; db: Db } | Response> {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  const db = createServiceRoleClient();
  const { data, error } = await db.from("library_fetchers").select("agent_id").eq("agent_id", agent.id).maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to check this agent.");
  if (!data) return apiError(403, "not_a_library_fetcher", "This agent is not allowed to fetch library pages.");
  return { agent, db };
}

export interface LeasedJob {
  id: string;
  kind: string;
  params: unknown;
  dedupe_key: string;
}

/**
 * Loads a job the calling agent must hold the lease on. 404 = no such job; 403 = somebody else holds it, or the lease ran
 * out (another agent may already have it); 409 = the job is not in progress any more (already done or failed, e.g. a retry).
 */
export async function loadLeasedJob(db: Db, agent: AuthenticatedAgent, jobId: string): Promise<LeasedJob | Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return apiError(404, "not_found", "Job not found.");
  const { data: job, error } = await db
    .from("server_jobs")
    .select("id, kind, params, dedupe_key, status, claimed_by, lease_until")
    .eq("id", jobId)
    .maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to load the job.");
  if (!job) return apiError(404, "not_found", "Job not found.");
  if (job.claimed_by !== agent.id) return apiError(403, "no_lease", "You do not hold the lease on this job.");
  if (job.status !== "claimed") return apiError(409, "wrong_state", `Job is in state '${job.status}', expected 'claimed'.`);
  if (!job.lease_until || new Date(job.lease_until).getTime() < Date.now()) return apiError(403, "no_lease", "Your lease on this job has expired.");
  return { id: job.id, kind: job.kind, params: job.params, dedupe_key: job.dedupe_key };
}

/** Reads a JSON request body of at most MAX_BODY_BYTES: a Response (400 / 413) when it cannot. */
export async function readJsonBody(request: Request): Promise<unknown | Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return apiError(413, "too_large", "The request is too large.");
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return apiError(413, "too_large", "The request is too large.");
  try {
    return JSON.parse(raw);
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
}
