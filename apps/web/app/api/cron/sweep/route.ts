import { rejectUnlessCronAuthorized } from "@/lib/cron-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { adjustMonthlyUsage } from "@/lib/quota";
import { sweepRetention } from "@/lib/retention";
import { logger } from "@/lib/logger";
import { isAutoRetryEnabled, requeueFailedJob } from "@/lib/jobs/lifecycle";
import { filterAffectedRows, groupJobsByAttemptCount, groupQuotaReleases, jobsHoldingQuota } from "@/lib/cron-sweep";

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

/** A failed job that still has retries left keeps its quota reservation this long, then is cancelled (and released). */
const FAILED_RETRY_WINDOW_DAYS = 7;

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
  const rejected = rejectUnlessCronAuthorized(request);
  if (rejected) return rejected;

  const supabase = createServiceRoleClient();
  const nowIso = new Date().toISOString();
  const results = {
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

      // A test print never reserved quota (app/admin/printers/actions.ts), so
      // releasing for one would subtract from the sending admin's *shared*
      // monthly_usage reservation counters and quietly free quota held by one
      // of their real pending jobs. Excluded here, not deeper inside
      // groupQuotaReleases, so that helper stays a pure grouping function.
      const exhausted = affected.filter((job) => !job.is_test_print && job.attempt_count + 1 >= job.max_attempts);
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
      // Automatic retry (organization setting, default OFF): a job that is not out of attempts goes straight back to
      // the claim pool, keeping its reservation. Test prints are never auto-retried (an admin re-sends them).
      const retryable = affected.filter((job) => !job.is_test_print && job.attempt_count + 1 < job.max_attempts);
      if (retryable.length > 0) {
        const enabledByOrg = new Map<string, boolean>();
        for (const orgId of new Set(retryable.map((j) => j.organization_id))) {
          enabledByOrg.set(orgId, await isAutoRetryEnabled(supabase, orgId));
        }
        for (const job of retryable) {
          if (!enabledByOrg.get(job.organization_id)) continue;
          if (await requeueFailedJob(supabase, { ...job, attempt_count: job.attempt_count + 1 }, { type: "system" })) {
            results.autoRetried += 1;
          }
        }
      }
    }
  }

  // 3b. Abandon failed jobs nobody retried. A failed job with attempts left keeps its quota reservation so the owner
  //     can press Try again; after this long we treat it as given up: cancel it and release exactly once.
  const abandonBefore = new Date(Date.parse(nowIso) - FAILED_RETRY_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: staleFailed } = await supabase
    .from("print_jobs")
    .select("id, organization_id, created_by, attempt_count, max_attempts, is_test_print, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode")
    .eq("status", "failed")
    .lt("updated_at", abandonBefore)
    .order("updated_at", { ascending: true })
    .limit(SELECTION_LIMIT);
  for (const job of (staleFailed ?? []).filter((j) => j.attempt_count < j.max_attempts)) {
    const { data: cancelled } = await supabase
      .from("print_jobs")
      .update({ status: "cancelled" })
      .eq("id", job.id)
      .eq("status", "failed")
      .eq("attempt_count", job.attempt_count)
      .select("id");
    if (!cancelled || cancelled.length === 0) continue;
    results.abandonedFailed += 1;
    await supabase.from("print_job_events").insert({
      job_id: job.id,
      event_type: "JOB_CANCELLED" as const,
      actor_type: "system" as const,
      metadata: { reason: "failed_and_not_retried" },
    });
    if (!job.is_test_print) {
      const [group] = groupQuotaReleases([
        {
          organizationId: job.organization_id,
          userId: job.created_by,
          sourcePdfPages: job.source_pdf_pages,
          copies: job.copies,
          estimatedPrintedSides: job.estimated_printed_sides,
          estimatedPhysicalSheets: job.estimated_physical_sheets,
          colorMode: job.color_mode,
        },
      ]);
      if (group) {
        await adjustMonthlyUsage(supabase, { organizationId: group.organizationId, userId: group.userId }, group.amounts, "physical_sheets", null, "release");
      }
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
  const retention = await sweepRetention(supabase, { now: new Date(nowIso), limit: SELECTION_LIMIT });
  results.filesDeleted = retention.filesDeleted;

  return Response.json({ ok: true, ranAt: nowIso, results });
}

/** GitHub Actions' cron-sweep workflow calls this with POST (curl -X POST); Vercel Cron uses GET. */
export const POST = GET;
