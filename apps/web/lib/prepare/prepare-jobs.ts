import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest, type AuthenticatedAgent } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";

/**
 * Prepare jobs (docs/PREPARE-JOBS-DESIGN.md, work package P1): the PDF steps of a print run on the organization's own print
 * server. Rows live in `server_jobs` (kind `prepare_pdf`, migration 0057). Every route here is bearer-authenticated as an agent
 * and only ever touches the CALLING AGENT'S OWN ORGANIZATION'S jobs.
 */

export const PREPARE_KIND = "prepare_pdf";
/** How long a print server holds a prepare job before another server of the same organization may take it over. */
export const PREPARE_LEASE_SECONDS = 120;
/** A prepare job waiting this long (no print server online) is given up on: failed with error `expired` (owner decision: 24 hours). */
export const PREPARE_QUEUE_EXPIRY_MS = 24 * 60 * 60_000;
/** Signed download link lifetime for the original file. */
export const ORIGINAL_URL_TTL_SECONDS = 300;
/** Longest plain-language reason kept on a failed job. */
export const MAX_REASON_CHARS = 300;
export const MAX_BODY_BYTES = 70_000;
/** The longest `params` a prepare job may carry (the database allows 16000 bytes; this leaves headroom). */
export const MAX_PARAMS_BYTES = 15_000;

export type Db = ReturnType<typeof createServiceRoleClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every prepare route starts here: a valid agent credential (401 otherwise). */
export async function requirePrepareAgent(request: Request): Promise<{ agent: AuthenticatedAgent; db: Db } | Response> {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  return { agent, db: createServiceRoleClient() };
}

export interface PrepareLease {
  id: string;
  params: unknown;
  sourcePath: string;
  organizationId: string;
  requestedBy: string;
}

/**
 * Loads a prepare job the calling agent must hold the lease on.
 * 404 = no such job FOR THIS ORGANIZATION (another organization's job looks exactly like a missing one);
 * 403 = somebody else holds it, or the lease ran out; 409 `cancelled` = the sender cancelled (the agent must drop its work);
 * 409 `wrong_state` = already done or failed.
 */
export async function loadPrepareLease(db: Db, agent: AuthenticatedAgent, jobId: string): Promise<PrepareLease | Response> {
  if (!UUID.test(jobId)) return apiError(404, "not_found", "Job not found.");
  const { data: job, error } = await db
    .from("server_jobs")
    .select("id, kind, params, source_path, organization_id, requested_by, status, claimed_by, lease_until")
    .eq("id", jobId)
    .maybeSingle();
  if (error) return apiError(500, "internal_error", "Failed to load the job.");
  if (!job || job.kind !== PREPARE_KIND || job.organization_id !== agent.organizationId) return apiError(404, "not_found", "Job not found.");
  if (job.status === "cancelled") return apiError(409, "cancelled", "The sender cancelled this job. Discard your work.");
  if (job.claimed_by !== agent.id) return apiError(403, "no_lease", "You do not hold the lease on this job.");
  if (job.status !== "claimed") return apiError(409, "wrong_state", `Job is in state '${job.status}', expected 'claimed'.`);
  if (!job.lease_until || new Date(job.lease_until).getTime() < Date.now()) return apiError(403, "no_lease", "Your lease on this job has expired.");
  if (!job.source_path || !job.requested_by) return apiError(500, "internal_error", "The job is incomplete.");
  return { id: job.id, params: job.params, sourcePath: job.source_path, organizationId: job.organization_id, requestedBy: job.requested_by };
}

/** The only place a prepared file may be written: the server chooses the path, the agent never does. */
export function preparedFolder(organizationId: string, jobId: string): string {
  return `prepared/${organizationId}/${jobId}/`;
}
export function newPreparedPath(organizationId: string, jobId: string): string {
  return `${preparedFolder(organizationId, jobId)}${randomUUID()}.pdf`;
}

/**
 * What the print server reports when it has prepared a file. Strict on purpose: unknown keys are refused, so the stored
 * result is always a shape this website understands. P2 (splitting createPrintJob) extends it.
 */
export const prepareResultSchema = z
  .object({
    /** Where the prepared (derived) file was uploaded; null when the original is printed as it is. Checked against the job's own folder. */
    preparedPath: z.string().max(300).nullable(),
    sourcePages: z.number().int().min(0).max(5000),
    bookletPaddingAdded: z.number().int().min(0).max(8).optional(),
    /** Plain names of things the preparation noticed (for example "type3_fonts_rasterized"). */
    flags: z.array(z.string().max(60)).max(30).optional(),
    /** The text-fidelity safeguard's verdict, when it ran. */
    fidelity: z.enum(["same", "changed", "skipped"]).optional(),
    /** Set when the file cannot be printed; the sender sees this plain reason and no print job is created. */
    rejectedReason: z.string().max(MAX_REASON_CHARS).optional(),
    // What the finish step needs from a successfully prepared job (packages/pdf/src/prepare-wire.ts):
    held: z.boolean().optional(),
    heldReason: z.string().max(600).nullable().optional(),
    effectivePageCount: z.number().int().min(0).max(5000).optional(),
    pageRangeText: z.string().max(200).nullable().optional(),
    fileSizeBytes: z.number().int().min(0).max(2_000_000_000).optional(),
    pictureCopy: z.boolean().optional(),
    /** An inline error from the PDF steps, with the field it belongs next to. */
    error: z
      .object({
        code: z.enum(["bad_pdf", "invalid_page_range", "subset_failed", "booklet_failed"]),
        message: z.string().max(600),
        fieldErrors: z.object({ pageRange: z.string().max(600).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    needsBookletConfirm: z
      .object({ sourcePages: z.number().int().min(0).max(5000), paddedPages: z.number().int().min(0).max(5000), blankPagesAdded: z.number().int().min(0).max(8) })
      .strict()
      .optional(),
  })
  .strict();
export type PrepareResult = z.infer<typeof prepareResultSchema>;

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

export { PRINT_JOBS_BUCKET };
