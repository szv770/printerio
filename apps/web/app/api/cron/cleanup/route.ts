import { rejectUnlessCronAuthorized } from "@/lib/cron-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { sweepRetention } from "@/lib/retention";
import { pruneHousekeeping, sweepOrphans } from "@/lib/cleanup";
import { logger } from "@/lib/logger";

/** Same per-step cap the 15-minute sweep uses; a capped run just continues next week. */
const LIMIT = 500;

export const maxDuration = 60;

/**
 * Cleanup (Vercel Cron, daily 03:00 UTC - see vercel.json; it was weekly until 2026-10-26, when link-import and booklet files made a faster pace sensible):
 *  1. retention: purge stored PDFs of finished jobs past their org's window
 *     (default 7 days completed/failed, 3 rejected) - rows are kept. The daily
 *     /api/cron/sweep does this too; running it here is a harmless idempotent
 *     backstop (files_purged_at is null filter) in case that sweep is paused.
 *  2. orphaned storage objects (gateway-intake > 24h, job files with no row);
 *  3. bounded-table housekeeping.
 * Each step is independent: one failing does not stop the others.
 */
export async function GET(request: Request) {
  const rejected = rejectUnlessCronAuthorized(request);
  if (rejected) return rejected;

  const supabase = createServiceRoleClient();
  const now = new Date();
  const results = {
    filesDeleted: 0,
    jobsPurged: 0,
    intakeDeleted: 0,
    jobOrphansDeleted: 0,
    remoteCommandsDeleted: 0,
    truncated: false,
  };
  const errors: string[] = [];
  let orphanPaths: string[] = [];

  try {
    const r = await sweepRetention(supabase, { now, limit: LIMIT });
    results.filesDeleted = r.filesDeleted;
    results.jobsPurged = r.jobsPurged;
  } catch (err) {
    errors.push(`retention: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const r = await sweepOrphans(supabase, { now, maxDeletes: LIMIT });
    results.intakeDeleted = r.intakeDeleted;
    results.jobOrphansDeleted = r.jobOrphansDeleted;
    results.truncated = r.truncated;
    orphanPaths = r.orphanPaths;
  } catch (err) {
    errors.push(`orphans: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const r = await pruneHousekeeping(supabase, { now, limit: LIMIT });
    results.remoteCommandsDeleted = r.remoteCommandsDeleted;
  } catch (err) {
    errors.push(`housekeeping: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info("weekly cleanup finished", { step: "weekly_cleanup", ...results, errors });
  return Response.json({ ok: errors.length === 0, ranAt: now.toISOString(), results, orphanPaths, errors });
}

export const POST = GET;
