import {
  retentionCutoffIso,
  retentionGroupForStatus,
  retentionWindows,
  type RetentionGroup,
  type RetentionSettings,
} from "@/lib/retention";

/**
 * Pure summary of "how much storage is this organization's print history
 * actually using, and how much of it could be cleaned up right now" - the
 * numbers behind app/admin/storage.
 *
 * Deliberately derived from the same retention definitions the sweep itself
 * uses (lib/retention.ts), so the "cleanable now" figure an admin sees is, by
 * construction, exactly what pressing "Clean up now" will remove - not a
 * second, hand-maintained copy of the same rules that can quietly disagree.
 */

export interface StorageJobRow {
  status: string;
  /** print_jobs.file_size_bytes - `bigint` in Postgres, so PostgREST may hand
   *  it back as a string; normalized here rather than at every call site. */
  file_size_bytes: number | string;
  updated_at: string;
}

export interface StorageBucketSummary {
  jobs: number;
  bytes: number;
}

export interface StorageUsageSummary {
  /** Everything still holding files (files_purged_at is null). */
  total: StorageBucketSummary;
  /** Jobs still in flight or awaiting a decision - never touched by retention. */
  active: StorageBucketSummary;
  /** Finished jobs still inside their retention window. */
  withinRetention: StorageBucketSummary;
  /** Finished jobs already past their window - what a sweep would remove now. */
  cleanable: StorageBucketSummary;
  /** Cleanable jobs broken down by which window they fell out of. */
  cleanableByGroup: Record<RetentionGroup, StorageBucketSummary>;
}

function emptyBucket(): StorageBucketSummary {
  return { jobs: 0, bytes: 0 };
}

function add(bucket: StorageBucketSummary, bytes: number): void {
  bucket.jobs += 1;
  bucket.bytes += bytes;
}

function toBytes(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param rows  jobs whose files still exist (`files_purged_at is null`), with
 *              only the three columns this needs.
 * @param settings the organization's configured retention windows.
 * @param now   evaluation time - passed in, never read from the clock here,
 *              so this stays pure and testable.
 *
 * Note on precision: `file_size_bytes` is the size of the ORIGINAL upload. A
 * booklet job also stores a derived, imposed copy, which this does not count
 * (its size is never recorded on the row) - so the total is a floor, and the
 * admin page says so rather than presenting it as exact.
 */
export function summarizeStorageUsage(
  rows: StorageJobRow[],
  settings: RetentionSettings,
  now: Date,
): StorageUsageSummary {
  const cutoffByGroup = new Map<RetentionGroup, string>(
    retentionWindows(settings).map((window) => [window.group, retentionCutoffIso(window.days, now)]),
  );

  const summary: StorageUsageSummary = {
    total: emptyBucket(),
    active: emptyBucket(),
    withinRetention: emptyBucket(),
    cleanable: emptyBucket(),
    cleanableByGroup: { completed: emptyBucket(), rejected: emptyBucket(), failed: emptyBucket() },
  };

  for (const row of rows) {
    const bytes = toBytes(row.file_size_bytes);
    add(summary.total, bytes);

    const group = retentionGroupForStatus(row.status);
    if (!group) {
      add(summary.active, bytes);
      continue;
    }

    const cutoff = cutoffByGroup.get(group);
    // Same comparison the sweep's own selection makes: updated_at < cutoff.
    if (cutoff && row.updated_at < cutoff) {
      add(summary.cleanable, bytes);
      add(summary.cleanableByGroup[group], bytes);
    } else {
      add(summary.withinRetention, bytes);
    }
  }

  return summary;
}
