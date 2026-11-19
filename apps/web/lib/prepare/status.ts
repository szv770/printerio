import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { PREPARE_KIND } from "./prepare-jobs";

/**
 * What the "Preparing your file..." page shows (docs/PREPARE-JOBS-DESIGN.md). One plain answer per prepare job, built from the job row and whether the
 * school's print server is reporting in. Only the sender's own job is ever returned. Read with the service-role client AFTER the caller was
 * authenticated, because the browser (a member, not an admin) cannot read the print servers' heartbeat under RLS.
 */
export type PrepareView =
  | { state: "preparing"; fileName: string; serverOnline: boolean; canCancel: true }
  | { state: "done"; fileName: string; printJobId: string }
  | { state: "needs_booklet_confirm"; fileName: string; needsBookletConfirm: { sourcePages: number; paddedPages: number; blankPagesAdded: number } }
  | { state: "failed"; fileName: string; message: string; fieldError?: string }
  | { state: "cancelled"; fileName: string };

/** A print server counts as online when it reported in this recently (its heartbeat is every 30 s). */
export const SERVER_ONLINE_MS = 5 * 60_000;

const EXPIRED = "Your print server was not available for too long, so this file was not prepared. Submit it again.";
const GENERIC = "Something went wrong preparing this file. Submit it again.";

export function viewFromRow(
  row: { status: string; params: unknown; result: unknown },
  serverOnline: boolean,
): PrepareView {
  const finish = (row.params as { finish?: { originalFileName?: string } } | null)?.finish;
  const fileName = typeof finish?.originalFileName === "string" ? finish.originalFileName : "your file";
  const result = (row.result ?? null) as {
    printJobId?: string;
    rejectedReason?: string;
    error?: { message?: string; fieldErrors?: { pageRange?: string } } | string;
    needsBookletConfirm?: { sourcePages: number; paddedPages: number; blankPagesAdded: number };
  } | null;

  if (row.status === "cancelled") return { state: "cancelled", fileName };
  if (result?.printJobId) return { state: "done", fileName, printJobId: result.printJobId };
  if (result?.needsBookletConfirm) return { state: "needs_booklet_confirm", fileName, needsBookletConfirm: result.needsBookletConfirm };

  const errObj = result && typeof result.error === "object" ? result.error : null;
  const errText = result && typeof result.error === "string" ? result.error : null;
  if (row.status === "failed" || errObj || errText || result?.rejectedReason) {
    const message = errObj?.message ?? result?.rejectedReason ?? (errText === "expired" ? EXPIRED : errText) ?? GENERIC;
    return { state: "failed", fileName, message, ...(errObj?.fieldErrors?.pageRange ? { fieldError: errObj.fieldErrors.pageRange } : {}) };
  }
  // queued, claimed, or done but not yet turned into a print job (the retry finishes those within a minute or so)
  return { state: "preparing", fileName, serverOnline, canCancel: true };
}

export async function loadPrepareView(db: SupabaseClient<Database>, userId: string, jobId: string): Promise<PrepareView | null> {
  const { data: job } = await db
    .from("server_jobs")
    .select("status, params, result, organization_id")
    .eq("id", jobId)
    .eq("kind", PREPARE_KIND)
    .eq("requested_by", userId)
    .maybeSingle();
  if (!job) return null;
  let online = true;
  if (job.status === "queued" && job.organization_id) {
    const since = new Date(Date.now() - SERVER_ONLINE_MS).toISOString();
    const { data } = await db.from("agents").select("id").eq("organization_id", job.organization_id).eq("status", "active").gte("last_seen_at", since).limit(1);
    online = !!data && data.length > 0;
  }
  return viewFromRow(job, online);
}
