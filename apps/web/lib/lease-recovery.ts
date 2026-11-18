import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { adjustMonthlyUsage } from "@/lib/quota";
import { isAutoRetryEnabled, requeueFailedJob } from "@/lib/jobs/lifecycle";
import { filterAffectedRows, groupJobsByAttemptCount, groupQuotaReleases } from "@/lib/cron-sweep";
import { logger } from "@/lib/logger";

type Client = SupabaseClient<Database>;

/** Job states in which an Agent holds the job but has not finished with it. */
export const MID_FLIGHT_STATUSES = ["downloading", "downloaded", "printing", "submitted_to_spooler"] as const;

/** Exactly the columns the recovery step reads (quota release, retry decision); not the whole print_jobs row. */
const STUCK_JOB_COLUMNS =
  "id, organization_id, created_by, attempt_count, max_attempts, is_test_print, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode";

export const STALE_LEASE_MESSAGE = "Agent lease expired mid-operation (agent likely disconnected or crashed).";

export interface LeaseRecoveryOptions {
  /** "Now" as an ISO string; the lease must be strictly older than this (minus graceMs) to count as expired. */
  nowIso: string;
  /** Max candidate rows per query (per status). */
  limit: number;
  /** Extra time past lease_expires_at before a job is touched. 0 for the sweep. */
  graceMs?: number;
  /** Restrict recovery to one organization's jobs on specific printer profiles (the polling Agent's own work). Omit for the global sweep. */
  scope?: { organizationId: string; printerProfileIds: string[] };
  /** Called when a query hits `limit` (the sweep logs it). */
  onCapHit?: (step: "release_leases" | "fail_stale_lease", status: string) => void;
}

export interface LeaseRecoveryResult {
  releasedLeases: number;
  failedFromStaleLease: number;
  autoRetried: number;
}

/**
 * Lease recovery shared by the cron sweep (steps 2 and 3) and the Agent's own
 * `claimable` poll (opportunistic, scoped to that Agent's printer profiles).
 * One implementation so quota accounting can never diverge.
 *
 *  - claimed and lease expired      -> back to `approved` (nothing was done yet, no quota change).
 *  - mid-flight and lease expired   -> `failed`, attempt_count + 1, and the quota reservation is released only
 *    when attempts are exhausted (test prints never reserved). Retryable jobs are re-queued when the org enabled
 *    automatic retry.
 *
 * Every write is a conditional UPDATE (status + lease/attempt_count re-asserted) and events/quota releases are
 * built ONLY from the rows the UPDATE actually returned, so running this concurrently or repeatedly (sweep + a
 * poll in the same second) cannot release quota twice: the second runner's UPDATE matches nothing.
 */
export async function recoverExpiredLeases(supabase: Client, opts: LeaseRecoveryOptions): Promise<LeaseRecoveryResult> {
  const result: LeaseRecoveryResult = { releasedLeases: 0, failedFromStaleLease: 0, autoRetried: 0 };
  const cutoffIso = new Date(Date.parse(opts.nowIso) - (opts.graceMs ?? 0)).toISOString();
  const { scope, limit } = opts;
  if (scope && scope.printerProfileIds.length === 0) return result;

  // 2. Claimed-but-untouched leases simply return to the pool for reclaim.
  let claimedQuery = supabase.from("print_jobs").select("id").eq("status", "claimed").lt("lease_expires_at", cutoffIso);
  if (scope) {
    claimedQuery = claimedQuery.eq("organization_id", scope.organizationId).in("printer_profile_id", scope.printerProfileIds);
  }
  const { data: releaseCandidates } = await claimedQuery.order("lease_expires_at", { ascending: true }).limit(limit);
  const releaseCandidateIds = (releaseCandidates ?? []).map((j) => j.id);
  if (releaseCandidateIds.length === limit) opts.onCapHit?.("release_leases", "claimed");

  if (releaseCandidateIds.length > 0) {
    const { data: released } = await supabase
      .from("print_jobs")
      .update({ status: "approved", lease_owner_agent_id: null, lease_expires_at: null })
      .in("id", releaseCandidateIds)
      .eq("status", "claimed")
      .lt("lease_expires_at", cutoffIso)
      .select("id");
    const releasedRows = released ?? [];
    result.releasedLeases = releasedRows.length;
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

  // 3. Jobs interrupted mid-flight whose lease expired - the agent likely crashed or disconnected. Mark failed (a
  //    valid transition from all four states) rather than leaving them stuck forever; release quota if retries are
  //    exhausted. attempt_count varies per job, so group by each job's current attempt_count and issue one UPDATE
  //    per group, each guarded by `attempt_count = <that value>` so a job whose attempt_count changed in between is
  //    excluded rather than double-bumped.
  for (const midFlightStatus of MID_FLIGHT_STATUSES) {
    let stuckQuery = supabase.from("print_jobs").select(STUCK_JOB_COLUMNS).eq("status", midFlightStatus).lt("lease_expires_at", cutoffIso);
    if (scope) {
      stuckQuery = stuckQuery.eq("organization_id", scope.organizationId).in("printer_profile_id", scope.printerProfileIds);
    }
    const { data: stuck } = await stuckQuery.order("lease_expires_at", { ascending: true }).limit(limit);
    const stuckJobs = stuck ?? [];
    if (stuckJobs.length === 0) continue;
    if (stuckJobs.length === limit) opts.onCapHit?.("fail_stale_lease", midFlightStatus);

    const attemptGroups = groupJobsByAttemptCount(stuckJobs.map((job) => ({ id: job.id, attemptCount: job.attempt_count })));

    const updatedIds: string[] = [];
    await Promise.all(
      attemptGroups.map(async (group) => {
        const { data } = await supabase
          .from("print_jobs")
          .update({
            status: "failed",
            attempt_count: group.currentAttemptCount + 1,
            error_message: STALE_LEASE_MESSAGE,
          })
          .in("id", group.ids)
          .eq("status", midFlightStatus)
          .eq("attempt_count", group.currentAttemptCount)
          .lt("lease_expires_at", cutoffIso)
          .select("id");
        for (const row of data ?? []) updatedIds.push(row.id);
      }),
    );

    const affected = filterAffectedRows(stuckJobs, updatedIds);
    result.failedFromStaleLease += affected.length;
    if (affected.length === 0) continue;

    await supabase.from("print_job_events").insert(
      affected.map((job) => ({
        job_id: job.id,
        event_type: "LEASE_EXPIRED" as const,
        actor_type: "system" as const,
        metadata: { previousStatus: midFlightStatus },
      })),
    );

    // A test print never reserved quota (app/admin/printers/actions.ts), so releasing for one would subtract from
    // the sending admin's *shared* monthly_usage reservation counters. Excluded here, not inside groupQuotaReleases.
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
          result.autoRetried += 1;
        }
      }
    }
  }

  return result;
}

/**
 * The opportunistic form the Agent's claimable poll calls. Never throws: a recovery problem must not stop the
 * Agent from being offered work. Bounded (50 rows per status) and graced (a lease must be 2 minutes past expiry)
 * so an Agent that is merely slow on a long print is not failed under its own feet.
 */
export const OPPORTUNISTIC_LIMIT = 50;
export const OPPORTUNISTIC_GRACE_MS = 120_000;

/** An agent's own poll recovers its leases at most this often (per server instance); the daily sweep is the backstop. */
export const OPPORTUNISTIC_MIN_INTERVAL_MS = 5 * 60_000;
const lastRecoveryByAgent = new Map<string, number>();

/** Test hook: forget when each agent was last recovered. */
export function resetLeaseRecoveryThrottle(): void {
  lastRecoveryByAgent.clear();
}

export async function recoverExpiredLeasesForAgent(
  supabase: Client,
  scope: { organizationId: string; agentId: string; printerProfileIds: string[] },
  now: Date = new Date(),
): Promise<LeaseRecoveryResult | null> {
  // Throttled: a lease only matters minutes after it expired, so checking on every poll is pure database load.
  // Returns null (same as "failed, ignored") when skipped. The stamp is taken up front so concurrent polls don't pile in.
  const last = lastRecoveryByAgent.get(scope.agentId);
  if (last !== undefined && now.getTime() - last < OPPORTUNISTIC_MIN_INTERVAL_MS) return null;
  if (lastRecoveryByAgent.size > 1000) lastRecoveryByAgent.clear();
  lastRecoveryByAgent.set(scope.agentId, now.getTime());
  try {
    const result = await recoverExpiredLeases(supabase, {
      nowIso: now.toISOString(),
      limit: OPPORTUNISTIC_LIMIT,
      graceMs: OPPORTUNISTIC_GRACE_MS,
      scope: { organizationId: scope.organizationId, printerProfileIds: scope.printerProfileIds },
    });
    if (result.releasedLeases || result.failedFromStaleLease) {
      logger.info("claimable poll recovered expired leases", { agentId: scope.agentId, ...result });
    }
    return result;
  } catch (err) {
    logger.warn("claimable poll: lease recovery failed (ignored)", {
      agentId: scope.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
