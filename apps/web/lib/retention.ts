import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";

/**
 * File retention: the ONE place a print job's stored PDFs are removed.
 *
 * Three callers share this module, deliberately, so they cannot drift into
 * three subtly different notions of "delete a job's files":
 *
 *  1. the scheduled sweep (app/api/cron/sweep/route.ts), which walks every
 *     organization's configured retention windows;
 *  2. an admin's manual "clean up now" (app/admin/storage/actions.ts), which
 *     runs the exact same pass for one organization, immediately;
 *  3. a user deleting their own finished job's file early
 *     (app/(dashboard)/jobs/[id]/actions.ts).
 *
 * The invariant every one of them inherits from here: **only the Storage
 * objects are ever removed - the print_jobs row itself always survives**, so
 * job_number, page counts, quota history and the print_job_events audit trail
 * remain intact after the file is gone (docs/architecture.md sec 16).
 * `files_purged_at` records that the removal happened and is what keeps
 * repeat sweep ticks cheap (0015_retention_files_purged_at.sql).
 */

type Client = SupabaseClient<Database>;

/** Terminal statuses, grouped by which organization_settings retention window
 *  governs them. A status not listed here is a job still in flight (or still
 *  awaiting a decision), and its files are never touched by retention at all,
 *  regardless of age. */
export const RETENTION_GROUPS = {
  completed: ["completed"],
  rejected: ["rejected", "denied", "cancelled", "expired"],
  failed: ["failed"],
} as const;

export type RetentionGroup = keyof typeof RETENTION_GROUPS;

/** Which retention window a job in this status falls under, or null if the
 *  job is not in a terminal state at all. Shared with the storage-usage
 *  summary (lib/storage-usage.ts) so "what counts as cleanable" is defined
 *  exactly once. */
export function retentionGroupForStatus(status: string): RetentionGroup | null {
  for (const [group, statuses] of Object.entries(RETENTION_GROUPS) as [RetentionGroup, readonly string[]][]) {
    if (statuses.includes(status)) return group;
  }
  return null;
}

export interface RetentionSettings {
  retention_completed_days: number;
  retention_rejected_days: number;
  retention_failed_days: number;
}

export interface RetentionWindow {
  group: RetentionGroup;
  statuses: readonly string[];
  days: number;
}

/** Pairs each status group with this organization's configured window length. */
export function retentionWindows(settings: RetentionSettings): RetentionWindow[] {
  return [
    { group: "completed", statuses: RETENTION_GROUPS.completed, days: settings.retention_completed_days },
    { group: "rejected", statuses: RETENTION_GROUPS.rejected, days: settings.retention_rejected_days },
    { group: "failed", statuses: RETENTION_GROUPS.failed, days: settings.retention_failed_days },
  ];
}

export function retentionCutoffIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export interface PurgeableJob {
  id: string;
  original_file_path: string | null;
  derived_file_path: string | null;
}

export interface PurgeResult {
  /** Storage objects removed (a booklet job has two: original + derived). */
  filesDeleted: number;
  /** print_jobs rows marked files_purged_at - never rows deleted. */
  jobsPurged: number;
}

/**
 * Removes these jobs' Storage objects in one batched call and stamps
 * `files_purged_at` on the rows. Requires a client that may delete from the
 * bucket - in practice the service-role client, since Storage's own delete
 * policy (0007_storage.sql) only admits org_admins and the sweep runs with no
 * user at all.
 *
 * remove() is a no-op (not an error) for an object that is already gone, so a
 * path included twice across partial runs is harmless. `files_purged_at` is
 * only written if the removal itself succeeded - a failed remove leaves the
 * row unmarked so the next pass retries it, rather than recording a deletion
 * that did not happen.
 */
export async function purgeJobFiles(supabase: Client, jobs: PurgeableJob[], purgedAtIso: string): Promise<PurgeResult> {
  if (jobs.length === 0) return { filesDeleted: 0, jobsPurged: 0 };

  const paths = jobs.flatMap((job) =>
    [job.original_file_path, job.derived_file_path].filter((p): p is string => !!p),
  );
  if (paths.length === 0) return { filesDeleted: 0, jobsPurged: 0 };

  const { error: removeError } = await supabase.storage.from(PRINT_JOBS_BUCKET).remove(paths);
  if (removeError) {
    logger.error("failed to remove print job files from storage", {
      jobCount: jobs.length,
      pathCount: paths.length,
      error: removeError.message,
    });
    return { filesDeleted: 0, jobsPurged: 0 };
  }

  const { error: markError } = await supabase
    .from("print_jobs")
    .update({ files_purged_at: purgedAtIso })
    .in(
      "id",
      jobs.map((job) => job.id),
    );
  if (markError) {
    // The bytes are already gone; failing to mark only costs a wasted (and
    // harmless) re-remove on a later pass, so this is logged, not thrown.
    logger.error("removed print job files but failed to mark files_purged_at", {
      jobCount: jobs.length,
      error: markError.message,
    });
  }

  return { filesDeleted: paths.length, jobsPurged: jobs.length };
}

export interface SweepRetentionOptions {
  now: Date;
  /** Per-window cap on how many jobs one pass handles - a capped pass simply
   *  makes partial progress and the next one continues (docs/architecture.md
   *  sec 16). */
  limit: number;
  /** Restrict the pass to one organization (the admin "clean up now" action).
   *  Omitted by the scheduled sweep, which covers every organization. */
  organizationId?: string;
}

/**
 * The retention pass itself: for every organization (or just one), for each
 * of its three configured windows, find terminal jobs older than the window
 * whose files are still present, and purge them.
 *
 * Every selection is a re-query by status/timestamp (never an offset/cursor)
 * and `files_purged_at is null` excludes everything a previous pass already
 * handled, so running this twice - or running the admin's manual pass while a
 * scheduled tick is in flight - is safe and simply finds less to do.
 */
export async function sweepRetention(supabase: Client, options: SweepRetentionOptions): Promise<PurgeResult> {
  const purgedAtIso = options.now.toISOString();
  const total: PurgeResult = { filesDeleted: 0, jobsPurged: 0 };

  let settingsQuery = supabase
    .from("organization_settings")
    .select("organization_id, retention_completed_days, retention_rejected_days, retention_failed_days");
  if (options.organizationId) settingsQuery = settingsQuery.eq("organization_id", options.organizationId);
  const { data: orgSettings } = await settingsQuery;

  for (const org of orgSettings ?? []) {
    for (const window of retentionWindows(org)) {
      const cutoff = retentionCutoffIso(window.days, options.now);
      const { data: toClean } = await supabase
        .from("print_jobs")
        .select("id, original_file_path, derived_file_path")
        .eq("organization_id", org.organization_id)
        .in("status", window.statuses as unknown as string[])
        .lt("updated_at", cutoff)
        .not("original_file_path", "is", null)
        .is("files_purged_at", null)
        .order("updated_at", { ascending: true })
        .limit(options.limit);
      const jobs = toClean ?? [];
      if (jobs.length === 0) continue;
      if (jobs.length === options.limit) {
        logger.info("retention pass cap hit, will continue on the next run", {
          step: "retention",
          organizationId: org.organization_id,
          group: window.group,
          limit: options.limit,
        });
      }

      const result = await purgeJobFiles(supabase, jobs, purgedAtIso);
      total.filesDeleted += result.filesDeleted;
      total.jobsPurged += result.jobsPurged;
    }
  }

  return total;
}

export interface SelfPurgeCandidate {
  status: string;
  attempt_count: number;
  max_attempts: number;
  files_purged_at: string | null;
  original_file_path: string | null;
}

export type SelfPurgeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether the *owner* of a job may delete its stored file right now, ahead of
 * the organization's retention window. Pure, so the rule is unit-testable and
 * stated in exactly one place (the Server Action re-checks the live row
 * against it - it is never decided in the browser).
 *
 * The rule is deliberately narrower than the sweep's:
 *  - the job must be in a terminal state (the same terminal statuses
 *    retention itself recognises), so an in-flight or still-pending job can
 *    never have the file pulled out from under the Agent or the approver;
 *  - a `failed` job additionally has to have exhausted its retry budget,
 *    because `failed -> claimed` is a legal transition in the state machine
 *    (packages/shared/src/job-state.ts) and a retry needs the file to exist;
 *  - the file must still be there.
 */
export function canOwnerPurgeFiles(job: SelfPurgeCandidate): SelfPurgeCheck {
  if (job.files_purged_at) return { ok: false, reason: "This job's file has already been deleted." };
  if (!job.original_file_path) return { ok: false, reason: "This job has no stored file." };

  const group = retentionGroupForStatus(job.status);
  if (!group) {
    return {
      ok: false,
      reason: "This job hasn't finished yet. You can delete its file once it has printed, or been rejected or cancelled.",
    };
  }
  if (group === "failed" && job.attempt_count < job.max_attempts) {
    return {
      ok: false,
      reason: "This job can still be retried, so its file is kept for now. It's removed automatically once retries run out.",
    };
  }
  return { ok: true };
}
