import { rejectUnlessCronAuthorized } from "@/lib/cron-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { adjustMonthlyUsage } from "@/lib/quota";
import { sweepRetention } from "@/lib/retention";
import { logger } from "@/lib/logger";
import { recoverExpiredLeases } from "@/lib/lease-recovery";
import { collectRetryableFailed, filterAffectedRows, groupJobsByAttemptCount, groupQuotaReleases, jobsHoldingQuota } from "@/lib/cron-sweep";

/**
 * Cap on every main selection query below (~200-500 is the reasonable band
 * for a per-tick batch; 500 chosen as the single consistent value): large
 * enough to clear a typical backlog in one daily run (vercel.json: 08:00 UTC), small enough that
 * the batched UPDATE/insert/RPC calls it drives comfortably finish within
 * maxDuration even on a slow day. Every query this cap touches is a re-query
 * by state/timestamp (never an offset/cursor), and processing a row is what
 * removes it from the next run's selection (status changes, or
 * files_purged_at is set) - so a capped, partial tick is always safe: the
 * next scheduled tick simply re-selects and continues the backlog rather
 * than skipping or double-processing anything.
 */
const SELECTION_LIMIT = 500;

/** A failed job that still has retries left keeps its quota reservation this long, then is cancelled (and released). */
const FAILED_RETRY_WINDOW_DAYS = 7;

/** Vercel Functions default/allow a wide range of duration limits depending
 *  on plan tier; this repo's docs don't pin one, so 60s is chosen as a value
 *  that's the max configurable on Vercel's most restrictive (Hobby) tier and
 *  comfortably inside the limit on every higher tier - enough headroom for a
 *  full SELECTION_LIMIT-sized batch across every step below, while still
 *  failing fast (rather than hanging) if something is actually stuck. */
export const maxDuration = 60;

/** Wall-clock budget: past this the optional later steps are skipped (and reported) instead of risking a timeout mid-write. */
const DEADLINE_MS = 45_000;

/**
 * Daily sweep (Vercel Cron, 08:00 UTC - see vercel.json -> this route). Idempotent: safe to run
 * repeatedly and concurrently (each step is a batched conditional
 * UPDATE ... WHERE id IN (...) keyed off the same predicate as its
 * SELECT, not a multi-step transaction that could double-apply). See
 * docs/architecture.md sec 13 (lease expiry) and sec 16 (retention).
 */
export async function GET(request: Request) {
  const rejected = rejectUnlessCronAuthorized(request);
  if (rejected) return rejected;

  const supabase = createServiceRoleClient();
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;
  const nowIso = new Date().toISOString();
  const results = {
    skippedForTime: [] as string[],
    expiredApprovals: 0,
    releasedLeases: 0,
    failedFromStaleLease: 0,
    autoRetried: 0,
    abandonedFailed: 0,
    filesDeleted: 0,
  };

  // 1. Expire pending_approval AND held jobs past their deadline (held -> expired is legal; a held job waits
  //    for its sender). Only pending_approval jobs reserved quota, so only those are released below. Batched:
  //    one SELECT (capped), one UPDATE ... WHERE id IN (...) RETURNING id,
  //    one bulk print_job_events insert built only from the ids the UPDATE
  //    actually returned, and quota releases batched per distinct
  //    (organization_id, user_id) via groupQuotaReleases.
  const { data: expiring } = await supabase
    .from("print_jobs")
    .select("id, status, organization_id, created_by, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode")
    .in("status", ["pending_approval", "held"])
    .lt("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(SELECTION_LIMIT);
  const expiringJobs = expiring ?? [];
  if (expiringJobs.length === SELECTION_LIMIT) {
    logger.info("cron sweep: expiring-approvals cap hit, will continue next run", {
      step: "expire_approvals",
      limit: SELECTION_LIMIT,
    });
  }

  if (expiringJobs.length > 0) {
    const candidateIds = expiringJobs.map((job) => job.id);
    // Re-assert the same predicate the SELECT used: a job that moved out of
    // pending_approval (e.g. a human approved/rejected it) between the
    // SELECT and this UPDATE simply won't match, and RETURNING tells us so.
    const { data: expiredRows } = await supabase
      .from("print_jobs")
      .update({ status: "expired" })
      .in("id", candidateIds)
      .in("status", ["pending_approval", "held"])
      .lt("expires_at", nowIso)
      .select("id");
    const expiredIds = (expiredRows ?? []).map((r) => r.id);
    results.expiredApprovals = expiredIds.length;

    const affected = filterAffectedRows(expiringJobs, expiredIds);
    if (affected.length > 0) {
      await supabase.from("print_job_events").insert(
        affected.map((job) => ({
          job_id: job.id,
          event_type: "JOB_EXPIRED" as const,
          actor_type: "system" as const,
          metadata: {},
        })),
      );

      const releaseGroups = groupQuotaReleases(
        jobsHoldingQuota(affected).map((job) => ({
          organizationId: job.organization_id,
          userId: job.created_by,
          sourcePdfPages: job.source_pdf_pages,
          copies: job.copies,
          estimatedPrintedSides: job.estimated_printed_sides,
          estimatedPhysicalSheets: job.estimated_physical_sheets,
          colorMode: job.color_mode,
        })),
      );
      await Promise.all(
        releaseGroups.map((group) =>
          adjustMonthlyUsage(
            supabase,
            { organizationId: group.organizationId, userId: group.userId },
            group.amounts,
            "physical_sheets",
            null,
            "release",
          ),
        ),
      );
    }
  }

  // 2 + 3. Lease recovery (claimed -> back to the pool; mid-flight -> failed, quota released when attempts are
  //    exhausted, optional auto-retry). The implementation lives in lib/lease-recovery.ts because the Agent's own
  //    claimable poll runs the SAME function (scoped to its profiles) - one copy of the quota accounting.
  if (outOfTime()) {
    results.skippedForTime.push("lease_recovery");
  } else {
    const recovery = await recoverExpiredLeases(supabase, {
      nowIso,
      limit: SELECTION_LIMIT,
      onCapHit: (step, status) =>
        logger.info("cron sweep: lease-recovery cap hit, will continue next run", { step, status, limit: SELECTION_LIMIT }),
    });
    results.releasedLeases = recovery.releasedLeases;
    results.failedFromStaleLease = recovery.failedFromStaleLease;
    results.autoRetried = recovery.autoRetried;
  }

  // 3b. Abandon failed jobs nobody retried. A failed job with attempts left keeps its quota reservation so the owner
  //     can press Try again; after this long we treat it as given up: cancel it and release exactly once.
  const abandonBefore = new Date(Date.parse(nowIso) - FAILED_RETRY_WINDOW_DAYS * 86_400_000).toISOString();
  //     The attempts-left condition cannot be expressed in the query (two columns), so the selection pages past
  //     exhausted rows (see collectRetryableFailed) instead of letting them fill the first page and starve newer ones.
  const staleFailed = outOfTime()
    ? []
    : await collectRetryableFailed(
        async (offset, size) => {
          const { data } = await supabase
            .from("print_jobs")
            .select("id, organization_id, created_by, attempt_count, max_attempts, is_test_print, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode")
            .eq("status", "failed")
            .lt("updated_at", abandonBefore)
            .order("updated_at", { ascending: true })
            .order("id", { ascending: true })
            .range(offset, offset + size - 1);
          return data ?? [];
        },
        { limit: SELECTION_LIMIT, pageSize: SELECTION_LIMIT, maxPages: 10, shouldStop: outOfTime },
      );
  if (staleFailed.length > 0) {
    // One conditional UPDATE per distinct attempt_count (each re-asserts status + attempt_count, so a job that was
    // retried in between is left alone), then events and quota releases only for the rows actually returned.
    const cancelledIds: string[] = [];
    await Promise.all(
      groupJobsByAttemptCount(staleFailed.map((j) => ({ id: j.id, attemptCount: j.attempt_count }))).map(async (group) => {
        const { data: cancelled } = await supabase
          .from("print_jobs")
          .update({ status: "cancelled" })
          .in("id", group.ids)
          .eq("status", "failed")
          .eq("attempt_count", group.currentAttemptCount)
          .select("id");
        for (const row of cancelled ?? []) cancelledIds.push(row.id);
      }),
    );
    const cancelledJobs = filterAffectedRows(staleFailed, cancelledIds);
    results.abandonedFailed = cancelledJobs.length;
    if (cancelledJobs.length > 0) {
      await supabase.from("print_job_events").insert(
        cancelledJobs.map((job) => ({
          job_id: job.id,
          event_type: "JOB_CANCELLED" as const,
          actor_type: "system" as const,
          metadata: { reason: "failed_and_not_retried" },
        })),
      );
      const releaseGroups = groupQuotaReleases(
        cancelledJobs
          .filter((job) => !job.is_test_print)
          .map((job) => ({
            organizationId: job.organization_id,
            userId: job.created_by,
            sourcePdfPages: job.source_pdf_pages,
            copies: job.copies,
            estimatedPrintedSides: job.estimated_printed_sides,
            estimatedPhysicalSheets: job.estimated_physical_sheets,
            colorMode: job.color_mode,
          })),
      );
      await Promise.all(
        releaseGroups.map((group) =>
          adjustMonthlyUsage(supabase, { organizationId: group.organizationId, userId: group.userId }, group.amounts, "physical_sheets", null, "release"),
        ),
      );
    }
  }

  // 4. Retention: delete storage files (never the job row itself, so
  //    job_number/audit history survives) for terminal jobs past their
  //    organization's configured retention window. A job still `approved`/
  //    `claimed`/etc. (active) is never touched, regardless of age.
  //    `files_purged_at is null` is what makes this idempotent-cheap on
  //    repeat ticks: once a job's files are removed it's marked and never
  //    reselected again, instead of being re-fetched and re-remove()'d on
  //    every future run forever.
  //
  //    The pass itself lives in lib/retention.ts because two other callers
  //    now share it - an admin's manual "clean up now" (which runs this exact
  //    logic for one organization, on demand) and a user deleting their own
  //    finished job's file early. One deletion path, one set of rules about
  //    what is eligible.
  if (outOfTime()) {
    results.skippedForTime.push("retention"); // the daily cleanup cron runs the same pass as a backstop
  } else {
    const retention = await sweepRetention(supabase, { now: new Date(nowIso), limit: SELECTION_LIMIT });
    results.filesDeleted = retention.filesDeleted;
  }

  return Response.json({ ok: true, ranAt: nowIso, results });
}

/** GitHub Actions' cron-sweep workflow calls this with POST (curl -X POST); Vercel Cron uses GET. */
export const POST = GET;
