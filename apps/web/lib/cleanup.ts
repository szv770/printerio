import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";

/**
 * Weekly housekeeping beyond the per-job retention pass (lib/retention.ts):
 *
 *  - orphaned Storage objects: `gateway-intake/<device>/<file>` uploads whose
 *    finalize never completed (docs/HANDOFF.md gap 2), and
 *    `org/<org>/jobs/<job>/*.pdf` files whose print_jobs row no longer exists;
 *  - bounded tables: finished remote_commands older than 30 days.
 *
 * Storage is only ever touched through the Storage API (list/remove), never
 * raw SQL on storage.objects. Every pass is capped so one run cannot time
 * out, and re-runnable: whatever it did not reach, the next run finds.
 */

type Client = SupabaseClient<Database>;

/** An object must be at least this old before it can be called an orphan. For
 *  job files this matters: the upload happens BEFORE the print_jobs insert, so
 *  a young file with no row is simply a job mid-creation. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const REMOTE_COMMAND_RETENTION_DAYS = 30;

const PAGE = 100;

interface StorageEntry {
  name: string;
  id: string | null;
  created_at?: string | null;
}

async function listAll(supabase: Client, path: string, maxEntries: number): Promise<StorageEntry[]> {
  const out: StorageEntry[] = [];
  for (let offset = 0; out.length < maxEntries; offset += PAGE) {
    const { data, error } = await supabase.storage.from(PRINT_JOBS_BUCKET).list(path, { limit: PAGE, offset });
    if (error || !data || data.length === 0) break;
    out.push(...(data as StorageEntry[]));
    if (data.length < PAGE) break;
  }
  return out.slice(0, maxEntries);
}

const isFolder = (e: StorageEntry) => e.id === null;
const isOldEnough = (e: StorageEntry, cutoffMs: number) => !!e.created_at && new Date(e.created_at).getTime() <= cutoffMs;

export interface OrphanSweepOptions {
  now: Date;
  /** Max objects deleted per run (default 500). */
  maxDeletes?: number;
  /** Max job folders inspected per run (default 1000). */
  maxJobFolders?: number;
}

export interface OrphanSweepResult {
  intakeDeleted: number;
  jobOrphansDeleted: number;
  /** Paths of job-file orphans removed (reported for the log; capped at 50). */
  orphanPaths: string[];
  /** True when a cap stopped the pass early; the next run continues. */
  truncated: boolean;
}

export async function sweepOrphans(supabase: Client, options: OrphanSweepOptions): Promise<OrphanSweepResult> {
  const maxDeletes = options.maxDeletes ?? 500;
  const maxJobFolders = options.maxJobFolders ?? 1000;
  const cutoffMs = options.now.getTime() - ORPHAN_MIN_AGE_MS;
  const result: OrphanSweepResult = { intakeDeleted: 0, jobOrphansDeleted: 0, orphanPaths: [], truncated: false };
  let budget = maxDeletes;

  const removePaths = async (paths: string[]): Promise<boolean> => {
    if (paths.length === 0) return true;
    const { error } = await supabase.storage.from(PRINT_JOBS_BUCKET).remove(paths);
    if (error) {
      logger.error("orphan sweep: remove failed", { step: "orphans", count: paths.length, error: error.message });
      return false;
    }
    return true;
  };

  // 1. gateway-intake: a successful finalize deletes its intake object, and a
  //    created job stores its own copy under org/..., so no job ever points at
  //    an intake path - anything here older than 24h is a leftover.
  for (const device of (await listAll(supabase, "gateway-intake", maxJobFolders)).filter(isFolder)) {
    if (budget <= 0) {
      result.truncated = true;
      break;
    }
    const files = await listAll(supabase, `gateway-intake/${device.name}`, 1000);
    const stale = files
      .filter((f) => !isFolder(f) && isOldEnough(f, cutoffMs))
      .map((f) => `gateway-intake/${device.name}/${f.name}`);
    const batch = stale.slice(0, budget);
    if (batch.length < stale.length) result.truncated = true;
    if (await removePaths(batch)) {
      result.intakeDeleted += batch.length;
      budget -= batch.length;
    }
  }

  // 2. org/<org>/jobs/<job>/*.pdf whose job row is gone.
  let foldersSeen = 0;
  outer: for (const org of (await listAll(supabase, "org", maxJobFolders)).filter(isFolder)) {
    const jobFolders = (await listAll(supabase, `org/${org.name}/jobs`, maxJobFolders)).filter(isFolder);
    for (let i = 0; i < jobFolders.length; i += 100) {
      if (budget <= 0 || foldersSeen >= maxJobFolders) {
        result.truncated = true;
        break outer;
      }
      const chunk = jobFolders.slice(i, i + 100);
      foldersSeen += chunk.length;
      const { data: live } = await supabase
        .from("print_jobs")
        .select("id")
        .in(
          "id",
          chunk.map((f) => f.name),
        );
      const liveIds = new Set((live ?? []).map((r) => r.id));
      for (const jobFolder of chunk) {
        if (liveIds.has(jobFolder.name)) continue;
        const base = `org/${org.name}/jobs/${jobFolder.name}`;
        const files = await listAll(supabase, base, 20);
        const stale = files.filter((f) => !isFolder(f) && isOldEnough(f, cutoffMs)).map((f) => `${base}/${f.name}`);
        const batch = stale.slice(0, budget);
        if (batch.length === 0) continue;
        if (await removePaths(batch)) {
          result.jobOrphansDeleted += batch.length;
          budget -= batch.length;
          for (const p of batch) if (result.orphanPaths.length < 50) result.orphanPaths.push(p);
        }
        if (budget <= 0) break;
      }
    }
  }

  logger.info("orphan sweep finished", {
    step: "orphans",
    intakeDeleted: result.intakeDeleted,
    jobOrphansDeleted: result.jobOrphansDeleted,
    truncated: result.truncated,
    orphanPaths: result.orphanPaths,
  });
  return result;
}

export interface HousekeepingOptions {
  now: Date;
  /** Max rows deleted per run (default 500). */
  limit?: number;
}

export interface HousekeepingResult {
  remoteCommandsDeleted: number;
}

/**
 * Tables that would otherwise grow forever. Deliberately conservative:
 *  - device_events: already capped at 200 per device on write (lib/devices).
 *  - private.rate_limit_buckets: self-cleaning inside check_rate_limit().
 *  - print_job_events / audit_logs / monthly_usage: NOT pruned - they are the
 *    audit trail and usage history, and grow at one-row-per-event scale.
 *  - remote_commands: finished (completed/failed) rows older than 30 days are
 *    deleted; pending/acknowledged ones are left for an operator to see.
 */
export async function pruneHousekeeping(supabase: Client, options: HousekeepingOptions): Promise<HousekeepingResult> {
  const limit = options.limit ?? 500;
  const cutoff = new Date(options.now.getTime() - REMOTE_COMMAND_RETENTION_DAYS * 86_400_000).toISOString();

  const { data: stale } = await supabase
    .from("remote_commands")
    .select("id")
    .in("status", ["completed", "failed"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  const ids = (stale ?? []).map((r) => r.id);
  if (ids.length === 0) return { remoteCommandsDeleted: 0 };

  const { error } = await supabase.from("remote_commands").delete().in("id", ids).in("status", ["completed", "failed"]);
  if (error) {
    logger.error("housekeeping: remote_commands delete failed", { step: "housekeeping", error: error.message });
    return { remoteCommandsDeleted: 0 };
  }
  return { remoteCommandsDeleted: ids.length };
}

/**
 * Deletes private.rate_limit_buckets windows older than a day (the table only prunes the calling key's own old
 * windows, so keys never used again would stay for ever). Goes through public.prune_rate_limit_buckets (migration
 * 0048; private.* is not reachable from the Data API). Never throws: until that migration is applied the RPC errors,
 * which is logged and counted as 0.
 */
export async function prunePrivateRateLimits(supabase: Client): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("prune_rate_limit_buckets", { p_older_than: "1 day" });
    if (error) {
      logger.warn("housekeeping: rate-limit prune skipped", { step: "housekeeping", error: error.message });
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (err) {
    logger.warn("housekeeping: rate-limit prune failed", { step: "housekeeping", error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
