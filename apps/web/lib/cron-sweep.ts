/**
 * Pure helpers for the cron sweep route (app/api/cron/sweep/route.ts).
 * Kept separate from the Supabase calls so the batching/grouping logic is
 * unit-testable without a database - see lib/cron-sweep.test.ts. Extracted
 * as part of the round-trip-efficiency hardening pass (docs/architecture.md
 * sec 16): the route used to do one UPDATE + one print_job_events INSERT +
 * (sometimes) one adjust_monthly_usage RPC per job, in a loop - these
 * helpers are what let it do the same work in a handful of batched calls
 * instead of one per job.
 */

import { usageAmountsForJob, type QuotaReleaseJobInput, type UsageAmounts } from "@/lib/quota";

export interface QuotaReleaseGroup {
  organizationId: string;
  userId: string;
  amounts: UsageAmounts;
}

/**
 * Groups per-job quota-release amounts by (organization_id, user_id) and
 * sums them, so the sweep can call adjust_monthly_usage's "release" mode
 * once per distinct org+user instead of once per job.
 *
 * This is safe (not just faster) specifically because "release" only ever
 * does `reserved_x = greatest(0, reserved_x - amount)` per column
 * (supabase/migrations/0010_quota_functions.sql), never a reserve/consume in
 * between. For any nonnegative a, b: greatest(0, x - a - b) equals
 * greatest(0, greatest(0, x - a) - b) - clamped subtraction of nonnegative
 * amounts commutes with the clamp - so releasing the summed amount once
 * produces byte-for-byte the same reserved_* columns as releasing job-by-job
 * in any order. (`reserve` and `consume` do not have this property - a
 * reserve's clamp is a *limit check*, not a floor, so this grouping is only
 * ever used for `release` calls.)
 */
export function groupQuotaReleases(jobs: QuotaReleaseJobInput[]): QuotaReleaseGroup[] {
  const byKey = new Map<string, QuotaReleaseGroup>();
  for (const job of jobs) {
    const key = `${job.organizationId}:${job.userId}`;
    const amounts = usageAmountsForJob(job);
    const existing = byKey.get(key);
    if (existing) {
      existing.amounts.pdfPages += amounts.pdfPages;
      existing.amounts.printedSides += amounts.printedSides;
      existing.amounts.physicalSheets += amounts.physicalSheets;
      existing.amounts.colorWeighted += amounts.colorWeighted;
    } else {
      byKey.set(key, { organizationId: job.organizationId, userId: job.userId, amounts });
    }
  }
  return [...byKey.values()];
}

/**
 * After a batched `UPDATE ... WHERE id IN (...) RETURNING id`, filters the
 * original candidate rows down to just the ones the UPDATE actually
 * affected. A job that transitioned away from the expected state between
 * the initial SELECT and the batched UPDATE (e.g. claimed by an Agent, or
 * approved by a human, in the same instant a cron tick ran) must not get a
 * stale print_job_events row or quota release recorded for it - only rows
 * the UPDATE's own RETURNING confirms were touched should be treated as
 * "this tick transitioned them".
 */
export function filterAffectedRows<T extends { id: string }>(candidates: T[], affectedIds: Iterable<string>): T[] {
  const affected = new Set(affectedIds);
  return candidates.filter((c) => affected.has(c.id));
}

export interface AttemptCountGroup {
  currentAttemptCount: number;
  ids: string[];
}

/**
 * Groups mid-flight lease-expired jobs by their current attempt_count so the
 * sweep can issue one `UPDATE ... SET attempt_count = <n+1> WHERE id IN
 * (...) AND attempt_count = <n>` per distinct attempt_count value, instead
 * of one UPDATE per job. attempt_count only takes a handful of distinct
 * values in practice (bounded by max_attempts, typically 3), so this
 * collapses an O(jobs) loop down to O(distinct attempt counts actually
 * present) - the `attempt_count = <n>` clause in the resulting UPDATE is
 * also what keeps each grouped call race-safe: a job whose attempt_count
 * changed since the SELECT simply won't match, the same guard the
 * unbatched per-row version got by construction (it always read-then-wrote
 * the same row with no gap).
 */
export function groupJobsByAttemptCount<T extends { id: string; attemptCount: number }>(
  jobs: T[],
): AttemptCountGroup[] {
  const byCount = new Map<number, string[]>();
  for (const job of jobs) {
    const ids = byCount.get(job.attemptCount) ?? [];
    ids.push(job.id);
    byCount.set(job.attemptCount, ids);
  }
  return [...byCount.entries()].map(([currentAttemptCount, ids]) => ({ currentAttemptCount, ids }));
}

/**
 * Of the jobs the sweep just expired, the ones that actually hold a quota
 * reservation. Only pending_approval jobs reserved quota; a `held` job never
 * did (print/actions.ts: reservesQuota is false for held), so releasing for
 * it would quietly free quota held by one of the same member's real jobs.
 */
export function jobsHoldingQuota<T extends { status: string }>(jobs: T[]): T[] {
  return jobs.filter((j) => j.status === "pending_approval");
}
