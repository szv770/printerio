import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/api-errors";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { adjustMonthlyUsage } from "@/lib/quota";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { getCronSecret } from "@/lib/env";
import { logger } from "@/lib/logger";
import { filterAffectedRows, groupJobsByAttemptCount, groupQuotaReleases } from "@/lib/cron-sweep";

/** Constant-time compare of two equal-or-different-length strings - avoids
 *  the length/content timing signal a plain `!==` would leak (consistent
 *  with lib/agent-auth.ts's device-secret comparison). */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so the "wrong length" case
    // doesn't return measurably faster than a "right length, wrong content" one.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Cap on every main selection query below (~200-500 is the reasonable band
 * for a per-tick batch; 500 chosen as the single consistent value): large
 * enough to clear a typical backlog in one 15-minute tick, small enough that
 * the batched UPDATE/insert/RPC calls it drives comfortably finish within
 * maxDuration even on a slow day. Every query this cap touches is a re-query
 * by state/timestamp (never an offset/cursor), and processing a row is what
 * removes it from the next tick's selection (status changes, or
 * files_purged_at is set) - so a capped, partial tick is always safe: the
 * next scheduled tick simply re-selects and continues the backlog rather
 * than skipping or double-processing anything.
 */
const SELECTION_LIMIT = 500;

/** Vercel Functions default/allow a wide range of duration limits depending
 *  on plan tier; this repo's docs don't pin one, so 60s is chosen as a value
 *  that's the max configurable on Vercel's most restrictive (Hobby) tier and
 *  comfortably inside the limit on every higher tier - enough headroom for a
 *  full SELECTION_LIMIT-sized batch across every step below, while still
 *  failing fast (rather than hanging) if something is actually stuck. */
export const maxDuration = 60;

/**
 * Periodic sweep (Vercel Cron -> this route). Idempotent: safe to run
 * repeatedly and concurrently (each step is a batched conditional
 * UPDATE ... WHERE id IN (...) keyed off the same predicate as its
 * SELECT, not a multi-step transaction that could double-apply). See
 * docs/architecture.md sec 13 (lease expiry) and sec 16 (retention).
 */
export async function GET(request: Request) {
  let expected: string;
  try {
    expected = getCronSecret();
  } catch (err) {
    // Distinct from a bad caller-supplied secret (401 below): this is an
    // operator misconfiguration (PRINTOS_CRON_SECRET was never set), and
    // should surface as a clear 500 rather than silently 401ing every call
    // forever with no clue why.
    return apiError(500, "misconfigured", err instanceof Error ? err.message : "Cron secret not configured.");
  }

  const authHeader = request.headers.get("authorization") ?? "";
  if (!safeCompare(authHeader, `Bearer ${expected}`)) {
    return apiError(401, "unauthenticated", "Invalid cron secret.");
  }

  const supabase = createServiceRoleClient();
  const nowIso = new Date().toISOString();
  const results = { expiredApprovals: 0, releasedLeases: 0, failedFromStaleLease: 0, filesDeleted: 0 };

  // 1. Expire pending_approval jobs past their approval deadline. Batched:
  //    one SELECT (capped), one UPDATE ... WHERE id IN (...) RETURNING id,
  //    one bulk print_job_events insert built only from the ids the UPDATE
  //    actually returned, and quota releases batched per distinct
  //    (organization_id, user_id) via groupQuotaReleases.
  const { data: expiring } = await supabase
    .from("print_jobs")
    .select("id, organization_id, created_by, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode")
    .eq("status", "pending_approval")
    .lt("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(SELECTION_LIMIT);
  const expiringJobs = expiring ?? [];
  if (expiringJobs.length === SELECTION_LIMIT) {
    logger.info("cron sweep: expiring-approvals cap hit, will continue next tick", {
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
      .eq("status", "pending_approval")
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
        affected.map((job) => ({
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

  // 2. Claimed-but-untouched leases simply return to the pool for reclaim.
  //    Select the capped candidate set first (PostgREST doesn't support
  //    LIMIT on UPDATE), then one batched UPDATE ... WHERE id IN (...), then
  //    one bulk event insert from the rows it actually affected.
  const { data: releaseCandidates } = await supabase
    .from("print_jobs")
    .select("id")
    .eq("status", "claimed")
    .lt("lease_expires_at", nowIso)
    .order("lease_expires_at", { ascending: true })
    .limit(SELECTION_LIMIT);
  const releaseCandidateIds = (releaseCandidates ?? []).map((j) => j.id);
  if (releaseCandidateIds.length === SELECTION_LIMIT) {
    logger.info("cron sweep: released-lease cap hit, will continue next tick", {
      step: "release_leases",
      limit: SELECTION_LIMIT,
    });
  }

  if (releaseCandidateIds.length > 0) {
    const { data: released } = await supabase
      .from("print_jobs")
      .update({ status: "approved", lease_owner_agent_id: null, lease_expires_at: null })
      .in("id", releaseCandidateIds)
      .eq("status", "claimed")
      .lt("lease_expires_at", nowIso)
      .select("id");
    const releasedRows = released ?? [];
    results.releasedLeases = releasedRows.length;
    if (releasedRows.length > 0) {
      await supabase.from("print_job_events").insert(
        releasedRows.map((job) => ({
          job_id: job.id,
          event_type: "LEASE_EXPIRED" as const,
          actor_type: "system" as const,
          metadata: {},
        })),
      );
    }
  }

  // 3. Jobs interrupted mid-flight (downloading/downloaded/printing/
  //    submitted_to_spooler) whose lease expired - the agent likely crashed
  //    or disconnected. Mark failed (a valid transition from all four states)
  //    rather than leaving them stuck forever; release quota if retries are
  //    exhausted. attempt_count varies per job, so it can't be set to one
  //    literal in a single UPDATE across every stuck job - instead, group by
  //    each job's *current* attempt_count (bounded by max_attempts, so only a
  //    handful of distinct values exist in practice) and issue one UPDATE per
  //    group, each guarded by `attempt_count = <that value>` so a job whose
  //    attempt_count changed in between is excluded rather than double-bumped.
  for (const midFlightStatus of ["downloading", "downloaded", "printing", "submitted_to_spooler"] as const) {
    const { data: stuck } = await supabase
      .from("print_jobs")
      .select("*")
      .eq("status", midFlightStatus)
      .lt("lease_expires_at", nowIso)
      .order("lease_expires_at", { ascending: true })
      .limit(SELECTION_LIMIT);
    const stuckJobs = stuck ?? [];
    if (stuckJobs.length === 0) continue;
    if (stuckJobs.length === SELECTION_LIMIT) {
      logger.info("cron sweep: mid-flight-lease cap hit, will continue next tick", {
        step: "fail_stale_lease",
        status: midFlightStatus,
        limit: SELECTION_LIMIT,
      });
    }

    const errorMessage = "Agent lease expired mid-operation (agent likely disconnected or crashed).";
    const attemptGroups = groupJobsByAttemptCount(
      stuckJobs.map((job) => ({ id: job.id, attemptCount: job.attempt_count })),
    );

    const updatedIds: string[] = [];
    await Promise.all(
      attemptGroups.map(async (group) => {
        const { data } = await supabase
          .from("print_jobs")
          .update({
            status: "failed",
            attempt_count: group.currentAttemptCount + 1,
            error_message: errorMessage,
          })
          .in("id", group.ids)
          .eq("status", midFlightStatus)
          .eq("attempt_count", group.currentAttemptCount)
          .select("id");
        for (const row of data ?? []) updatedIds.push(row.id);
      }),
    );

    const affected = filterAffectedRows(stuckJobs, updatedIds);
    results.failedFromStaleLease += affected.length;
    if (affected.length > 0) {
      await supabase.from("print_job_events").insert(
        affected.map((job) => ({
          job_id: job.id,
          event_type: "LEASE_EXPIRED" as const,
          actor_type: "system" as const,
          metadata: { previousStatus: midFlightStatus },
        })),
      );

      const exhausted = affected.filter((job) => job.attempt_count + 1 >= job.max_attempts);
      const releaseGroups = groupQuotaReleases(
        exhausted.map((job) => ({
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

  // 4. Retention: delete storage files (never the job row itself, so
  //    job_number/audit history survives) for terminal jobs past their
  //    organization's configured retention window. A job still `approved`/
  //    `claimed`/etc. (active) is never touched, regardless of age.
  //    `files_purged_at is null` is what makes this idempotent-cheap on
  //    repeat ticks: once a job's files are removed it's marked and never
  //    reselected again, instead of being re-fetched and re-remove()'d on
  //    every future run forever.
  const { data: orgSettings } = await supabase
    .from("organization_settings")
    .select("organization_id, retention_completed_days, retention_rejected_days, retention_failed_days");

  for (const org of orgSettings ?? []) {
    const statusWindows: Array<{ statuses: string[]; days: number }> = [
      { statuses: ["completed"], days: org.retention_completed_days },
      { statuses: ["rejected", "denied", "cancelled", "expired"], days: org.retention_rejected_days },
      { statuses: ["failed"], days: org.retention_failed_days },
    ];

    for (const window of statusWindows) {
      const cutoff = new Date(Date.now() - window.days * 86_400_000).toISOString();
      const { data: toClean } = await supabase
        .from("print_jobs")
        .select("id, original_file_path, derived_file_path")
        .eq("organization_id", org.organization_id)
        .in("status", window.statuses)
        .lt("updated_at", cutoff)
        .not("original_file_path", "is", null)
        .is("files_purged_at", null)
        .order("updated_at", { ascending: true })
        .limit(SELECTION_LIMIT);
      const jobs = toClean ?? [];
      if (jobs.length === 0) continue;
      if (jobs.length === SELECTION_LIMIT) {
        logger.info("cron sweep: retention cap hit, will continue next tick", {
          step: "retention",
          organizationId: org.organization_id,
          limit: SELECTION_LIMIT,
        });
      }

      // One remove() call for every path in this org/window batch, instead
      // of one per job - Supabase Storage's remove() already accepts an
      // array. remove() is a no-op (not an error) for objects that no
      // longer exist, so a path already gone from a previous partial run is
      // harmless to include again.
      const paths = jobs.flatMap((job) => [job.original_file_path, job.derived_file_path].filter((p): p is string => !!p));
      if (paths.length === 0) continue;

      const { error: removeError } = await supabase.storage.from(PRINT_JOBS_BUCKET).remove(paths);
      if (!removeError) {
        results.filesDeleted += paths.length;
        await supabase
          .from("print_jobs")
          .update({ files_purged_at: nowIso })
          .in(
            "id",
            jobs.map((job) => job.id),
          );
      }
    }
  }

  return Response.json({ ok: true, ranAt: nowIso, results });
}
