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
/** A cached library page is kept this long past its expiry (an expired page is never served; this only bounds the table). */
export const LIBRARY_PAGE_GRACE_DAYS = 30;
/** Saved daily text is pruned by its study date after this many days. */
export const DAILY_TEXT_RETENTION_DAYS = 60;
/** Finished (done / failed) library fetch jobs are deleted after this many days. */
export const SERVER_JOB_RETENTION_DAYS = 7;

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

export interface LibraryPruneResult {
  libraryPagesDeleted: number;
  libraryDailyTextsDeleted: number;
  serverJobsDeleted: number;
}

export interface HousekeepingResult extends LibraryPruneResult {
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
 *  - the library's own tables: see pruneLibraryData.
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

  let remoteCommandsDeleted = 0;
  if (ids.length > 0) {
    const { error } = await supabase.from("remote_commands").delete().in("id", ids).in("status", ["completed", "failed"]);
    if (error) logger.error("housekeeping: remote_commands delete failed", { step: "housekeeping", error: error.message });
    else remoteCommandsDeleted = ids.length;
  }
  return { remoteCommandsDeleted, ...(await pruneLibraryData(supabase, options)) };
}

/**
 * Bounds the three tables behind the library (docs/PHASE-C-PLAN.md), each independent and capped per run:
 *  - library_pages: rows whose `expires_at` is more than 30 days in the past (an expired page is never served anyway);
 *  - library_daily_texts: rows whose `study_date` is more than 60 days ago;
 *  - server_jobs: `done` or `failed` jobs last touched more than 7 days ago (a queued or claimed job is never deleted).
 * Never throws: a table that cannot be pruned (a failed query, a migration not applied yet) is logged and counted as 0.
 */
export async function pruneLibraryData(supabase: Client, options: HousekeepingOptions): Promise<LibraryPruneResult> {
  const limit = options.limit ?? 500;
  const ago = (days: number) => new Date(options.now.getTime() - days * 86_400_000).toISOString();
  const guarded = async (table: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (err) {
      logger.warn("housekeeping: library prune skipped", { step: "housekeeping", table, error: err instanceof Error ? err.message : String(err) });
      return 0;
    }
  };

  const libraryPagesDeleted = await guarded("library_pages", async () => {
    const cutoff = ago(LIBRARY_PAGE_GRACE_DAYS);
    const { data: stale } = await supabase.from("library_pages").select("key").lt("expires_at", cutoff).order("expires_at", { ascending: true }).limit(limit);
    const keys = (stale ?? []).map((r) => r.key);
    if (keys.length === 0) return 0;
    const { error } = await supabase.from("library_pages").delete().in("key", keys).lt("expires_at", cutoff);
    if (error) throw new Error(error.message);
    return keys.length;
  });

  const libraryDailyTextsDeleted = await guarded("library_daily_texts", async () => {
    const cutoff = ago(DAILY_TEXT_RETENTION_DAYS).slice(0, 10);
    // The table's key is (study, study_date), so the cap works on whole days: take the oldest rows, then delete everything up to the newest of their dates.
    const { data: stale } = await supabase.from("library_daily_texts").select("study_date").lt("study_date", cutoff).order("study_date", { ascending: true }).limit(limit);
    const last = (stale ?? []).at(-1)?.study_date;
    if (!last) return 0;
    const { data: removed, error } = await supabase.from("library_daily_texts").delete().lt("study_date", cutoff).lte("study_date", last).select("study");
    if (error) throw new Error(error.message);
    return removed?.length ?? 0;
  });

  const serverJobsDeleted = await guarded("server_jobs", async () => {
    const cutoff = ago(SERVER_JOB_RETENTION_DAYS);
    const { data: stale } = await supabase.from("server_jobs").select("id").in("status", ["done", "failed"]).lt("updated_at", cutoff).order("updated_at", { ascending: true }).limit(limit);
    const ids = (stale ?? []).map((r) => r.id);
    if (ids.length === 0) return 0;
    const { error } = await supabase.from("server_jobs").delete().in("id", ids).in("status", ["done", "failed"]);
    if (error) throw new Error(error.message);
    return ids.length;
  });

  return { libraryPagesDeleted, libraryDailyTextsDeleted, serverJobsDeleted };
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
