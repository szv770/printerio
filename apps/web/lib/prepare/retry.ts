import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PrepareWire } from "@printio/pdf/prepare-wire";
import { logger } from "@/lib/logger";
import { finishPrepareJob } from "./finish";
import { PREPARE_KIND } from "./prepare-jobs";

/**
 * A prepare job is marked `done` the moment the print server reports (that is what shuts out a cancel) and the print job is created right after.
 * If the website dies in between, the job is `done` with no print job and nothing says why. This finishes such jobs: it is safe to run at any time
 * and by several callers at once, because finishing is idempotent (the print job takes the prepare job's id; an existing one is returned as it is;
 * a cancelled job is never finished; a racing loser never marks a created job failed).
 *
 * A job is stuck when it is done, has no print job id, no inline error, no booklet question, no rejection, and has been done for a little while
 * (so a finish still running right now is left alone).
 */
export const STUCK_AFTER_MS = 60_000;

export async function retryStuckFinishes(
  db: SupabaseClient<Database>,
  opts: { organizationId?: string; limit?: number; now?: number } = {},
): Promise<number> {
  const cutoff = new Date((opts.now ?? Date.now()) - STUCK_AFTER_MS).toISOString();
  let query = db
    .from("server_jobs")
    .select("id, organization_id, requested_by, source_path, params, result")
    .eq("kind", PREPARE_KIND)
    .eq("status", "done")
    .lt("finished_at", cutoff)
    .order("finished_at", { ascending: true })
    .limit(opts.limit ?? 5);
  if (opts.organizationId) query = query.eq("organization_id", opts.organizationId);
  const { data, error } = await query;
  if (error || !data) {
    if (error) logger.warn("could not look for stuck prepare jobs", { error: error.message });
    return 0;
  }

  let finished = 0;
  for (const row of data) {
    const wire = row.result as (PrepareWire & { printJobId?: string }) | null;
    if (!wire || wire.printJobId || wire.error || wire.needsBookletConfirm || wire.rejectedReason) continue;
    if (!row.requested_by || !row.source_path) continue;
    try {
      const out = await finishPrepareJob(db, { id: row.id, organization_id: row.organization_id, requested_by: row.requested_by, source_path: row.source_path, params: row.params }, wire);
      if (out.status === "finished" || out.status === "already_finished") finished += 1;
      logger.warn("finished a prepare job that had been left half-done", { jobId: row.id, outcome: out.status });
    } catch (err) {
      logger.error("could not finish a stuck prepare job", { jobId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return finished;
}
