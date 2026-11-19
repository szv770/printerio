import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { PREPARE_KIND } from "./prepare-jobs";

/**
 * "Yes, add the blank pages": the print server stopped to ask whether a booklet may be padded with blank pages. Confirming puts the SAME prepare job back
 * in the queue with the confirmation set (same id, same upload), so nothing is uploaded twice. Only the sender, only a job that is waiting on exactly that
 * question: the update names the state, so a job that moved on (finished, cancelled) is never reopened.
 */
export async function confirmBookletForPrepareJob(db: SupabaseClient<Database>, userId: string, jobId: string): Promise<boolean> {
  const { data: job } = await db
    .from("server_jobs")
    .select("params, result, status")
    .eq("id", jobId)
    .eq("kind", PREPARE_KIND)
    .eq("requested_by", userId)
    .maybeSingle();
  const waiting = (job?.result as { needsBookletConfirm?: unknown } | null)?.needsBookletConfirm;
  if (!job || job.status !== "done" || !waiting) return false;

  const params = job.params as { pdf?: Record<string, unknown> } & Record<string, unknown>;
  const next = { ...params, pdf: { ...(params.pdf ?? {}), confirmBookletPadding: true } };
  const { data: updated } = await db
    .from("server_jobs")
    .update({ params: next as never, status: "queued", result: null, finished_at: null, lease_until: null, claimed_by: null })
    .eq("id", jobId)
    .eq("kind", PREPARE_KIND)
    .eq("requested_by", userId)
    .eq("status", "done")
    .select("id")
    .maybeSingle();
  return !!updated;
}
