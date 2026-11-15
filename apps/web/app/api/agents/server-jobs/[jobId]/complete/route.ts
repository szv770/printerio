import { z } from "zod";
import { apiError } from "@/lib/api-errors";
import { libraryKey, libraryKind, libraryTtlMs, parseLibraryRef } from "@/lib/library/cache";
import { checkPayload } from "@/lib/library/payload-schema";
import { loadLeasedJob, readJsonBody, requireLibraryFetcher } from "@/lib/library/server-jobs";
import { libraryPageUrl } from "@printio/shared/library/mafteiach-fetch";
import type { Json } from "@/lib/database.types";

/** The body is exactly `{ payload }`. A key or address in it is refused outright: the website works both out from the job. */
const bodySchema = z.object({ payload: z.unknown().refine((v) => v !== undefined, "payload is required") }).strict();

/**
 * See docs/agent-api.md. A library-fetcher agent that holds the lease on a job posts the parsed page. The website rebuilds
 * the key (and the source address) from the JOB'S OWN params, validates the payload against the page kind the job asked
 * for, writes the shared cache row and marks the job done. Nothing in the request chooses where the data goes.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requireLibraryFetcher(request);
  if (guard instanceof Response) return guard;
  const { agent, db } = guard;
  const { jobId } = await params;

  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return apiError(400, "invalid_body", "The body must be exactly { payload }.");

  const job = await loadLeasedJob(db, agent, jobId);
  if (job instanceof Response) return job;

  const ref = job.kind === "library_fetch" ? parseLibraryRef(job.params) : null;
  const key = ref ? libraryKey(ref) : null;
  if (!ref || !key || key !== job.dedupe_key) return apiError(409, "bad_job", "This job does not describe an allowed library page.");

  const checked = checkPayload(ref, body.data.payload);
  if (!checked.ok) return apiError(checked.code === "too_large" ? 413 : 400, `payload_${checked.code}`, checked.message);

  const now = Date.now();
  const { error: pageError } = await db.from("library_pages").upsert(
    {
      key,
      kind: libraryKind(ref),
      payload: checked.payload as unknown as Json,
      source_url: libraryPageUrl(ref),
      fetched_at: new Date(now).toISOString(),
      expires_at: new Date(now + libraryTtlMs(ref, checked.payload)).toISOString(),
      fetched_by: agent.id,
    },
    { onConflict: "key" },
  );
  if (pageError) return apiError(500, "internal_error", "Failed to store the page.");

  // Conditional on still holding the lease: if it was taken over in the meantime, the page just written is still valid
  // (it passed the same checks), but this job is not ours to close.
  const { data: closed, error: jobError } = await db
    .from("server_jobs")
    .update({ status: "done", result_key: key, error: null, lease_until: null })
    .eq("id", job.id)
    .eq("status", "claimed")
    .eq("claimed_by", agent.id)
    .select("id")
    .maybeSingle();
  if (jobError) return apiError(500, "internal_error", "Failed to finish the job.");
  if (!closed) return apiError(409, "wrong_state", "The job is no longer yours to finish.");
  return Response.json({ ok: true });
}
