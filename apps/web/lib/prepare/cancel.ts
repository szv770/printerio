import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { PREPARE_KIND, preparedFolder } from "./prepare-jobs";

/**
 * The sender cancels a file that is still waiting for, or being prepared by, the print server (owner decision 2026-11-19: yes, and it must be safe
 * even though preparing is fast). Only the sender's own job, only while it is `queued` or `claimed`: the update names those states, so it can never
 * undo a job that already finished. A print server that finishes anyway is answered `409 cancelled` by every prepare route and drops its work.
 * If the print job already exists the answer is `too_late` with its id, and the normal cancel of a print job applies instead.
 */
export type CancelOutcome = { ok: true } | { ok: false; reason: "not_found" } | { ok: false; reason: "too_late"; printJobId: string | null };

export async function cancelPrepareJob(db: SupabaseClient<Database>, userId: string, jobId: string): Promise<CancelOutcome> {
  const { data: cancelled, error } = await db
    .from("server_jobs")
    .update({ status: "cancelled", lease_until: null, finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("kind", PREPARE_KIND)
    .eq("requested_by", userId)
    .in("status", ["queued", "claimed"])
    .select("source_path, organization_id")
    .maybeSingle();
  if (error) {
    logger.error("could not cancel a prepare job", { jobId, error: error.message });
    return { ok: false, reason: "not_found" };
  }

  if (cancelled) {
    // Best effort: the upload, and anything the print server managed to upload before it was told.
    try {
      const bucket = db.storage.from(PRINT_JOBS_BUCKET);
      const toRemove: string[] = [];
      if (cancelled.source_path) toRemove.push(cancelled.source_path);
      const folder = preparedFolder(cancelled.organization_id, jobId).replace(/\/$/, "");
      const { data: listed } = await bucket.list(folder, { limit: 20 });
      for (const f of listed ?? []) toRemove.push(`${folder}/${f.name}`);
      if (toRemove.length > 0) await bucket.remove(toRemove);
    } catch (err) {
      logger.warn("could not clean up after a cancelled prepare job", { jobId, error: err instanceof Error ? err.message : String(err) });
    }
    return { ok: true };
  }

  const { data: job } = await db.from("server_jobs").select("status, result").eq("id", jobId).eq("kind", PREPARE_KIND).eq("requested_by", userId).maybeSingle();
  if (!job) return { ok: false, reason: "not_found" };
  const printJobId = (job.result as { printJobId?: unknown } | null)?.printJobId;
  return { ok: false, reason: "too_late", printJobId: typeof printJobId === "string" ? printJobId : null };
}
