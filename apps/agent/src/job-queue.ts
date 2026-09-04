/**
 * Local persistent job queue/state store. Survives process restarts (a
 * plain JSON file, written atomically via temp-file-then-rename) so the
 * agent doesn't lose track of in-flight jobs across a crash or service
 * restart (docs/architecture.md sec 17).
 *
 * This is deliberately NOT a general job history - `print_job_events` on the
 * cloud side is the durable audit trail (docs/architecture.md sec 15). This
 * store exists only to answer, on restart: "what was I in the middle of, and
 * what's the most honest thing I can report about it now?" - see
 * `reconcileOnStartup` in orchestrator.ts for how these records are used.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import type { JobState } from "@printos/shared";
import type { Logger } from "./logger.js";

export interface LocalJobRecord {
  jobId: string;
  jobNumber?: string;
  printerProfileId: string;
  /** Mirrors the cloud-side JobState for whichever transition this agent itself last drove or observed. */
  state: JobState;
  windowsQueueName?: string;
  localFilePath?: string;
  /** The Windows spooler job id this agent's own submission was identified as (spooler-monitor.ts findNewJobId) - undefined until `printing` has produced one. */
  spoolerJobId?: number;
  leaseExpiresAt?: string;
  attemptCount: number;
  lastError?: string;
  updatedAt: string;
}

interface StoreShape {
  version: 1;
  jobs: Record<string, LocalJobRecord>;
  /** printerProfileId -> windowsQueueName, learned opportunistically from download-url responses. Used only as a best-effort hint for RESTART_PRINT_QUEUE logging (commands.ts) - never authoritative. */
  printerProfileQueueMap: Record<string, string>;
}

function emptyStore(): StoreShape {
  return { version: 1, jobs: {}, printerProfileQueueMap: {} };
}

function storeFilePath(localStoragePath: string): string {
  return path.join(localStoragePath, "job-queue-state.json");
}

export interface JobQueue {
  getJob(jobId: string): LocalJobRecord | undefined;
  listActiveJobs(): LocalJobRecord[];
  upsertJob(jobId: string, patch: Partial<LocalJobRecord> & { printerProfileId?: string }): LocalJobRecord;
  removeJob(jobId: string): void;
  rememberQueueForProfile(printerProfileId: string, windowsQueueName: string): void;
  getQueueForProfile(printerProfileId: string): string | undefined;
  reload(): void;
}

/** Terminal-ish local states we don't need to keep tracking once reported. `failed` is kept briefly (not pruned here) since a retry may re-claim the same jobId. */
const PRUNE_ON_UPSERT_STATES = new Set<JobState>(["completed", "cancelled"]);

export function createJobQueue(localStoragePath: string, logger: Logger): JobQueue {
  mkdirSync(localStoragePath, { recursive: true });
  const filePath = storeFilePath(localStoragePath);
  let store: StoreShape = load();

  function load(): StoreShape {
    if (!existsSync(filePath)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoreShape;
      if (parsed.version !== 1 || typeof parsed.jobs !== "object") return emptyStore();
      return { version: 1, jobs: parsed.jobs ?? {}, printerProfileQueueMap: parsed.printerProfileQueueMap ?? {} };
    } catch (err) {
      logger.error("job-queue state file is corrupt - starting from an empty queue", {
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyStore();
    }
  }

  function persist(): void {
    try {
      const tmpPath = `${filePath}.tmp-${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      // A failed local persist must never crash the process (docs/architecture.md sec 17) -
      // worst case we lose the ability to resume this specific bookkeeping across a restart.
      logger.error("failed to persist job-queue state to disk", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    getJob(jobId) {
      return store.jobs[jobId];
    },
    listActiveJobs() {
      return Object.values(store.jobs);
    },
    upsertJob(jobId, patch) {
      const existing = store.jobs[jobId];
      const merged: LocalJobRecord = {
        jobId,
        printerProfileId: patch.printerProfileId ?? existing?.printerProfileId ?? "",
        state: patch.state ?? existing?.state ?? "claimed",
        attemptCount: patch.attemptCount ?? existing?.attemptCount ?? 0,
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      if (PRUNE_ON_UPSERT_STATES.has(merged.state)) {
        delete store.jobs[jobId];
        persist();
        return merged;
      }
      store.jobs[jobId] = merged;
      persist();
      return merged;
    },
    removeJob(jobId) {
      if (store.jobs[jobId]) {
        delete store.jobs[jobId];
        persist();
      }
    },
    rememberQueueForProfile(printerProfileId, windowsQueueName) {
      if (store.printerProfileQueueMap[printerProfileId] === windowsQueueName) return;
      store.printerProfileQueueMap[printerProfileId] = windowsQueueName;
      persist();
    },
    getQueueForProfile(printerProfileId) {
      return store.printerProfileQueueMap[printerProfileId];
    },
    reload() {
      store = load();
    },
  };
}

/**
 * Reconciliation ordering used when the agent restarts and finds a local
 * record whose state disagrees with what it can still verify. Not a total
 * order over JobState (some states are incomparable) - just enough of one to
 * answer "if I have to pick, which side's account of this job is more
 * advanced/authoritative" per docs/architecture.md sec 17. Terminal states
 * (other than `failed`, which structurally isn't terminal - see
 * job-state.ts) always win because nothing can un-complete/un-cancel a job.
 */
const PROGRESS_RANK: Record<JobState, number> = {
  draft: 0,
  pending_approval: 1,
  approved: 2,
  claimed: 3,
  downloading: 4,
  downloaded: 5,
  printing: 6,
  submitted_to_spooler: 7,
  completed: 8,
  denied: 8,
  rejected: 8,
  expired: 8,
  cancelled: 8,
  failed: -1, // handled specially - see moreAdvancedState
};

/**
 * Returns whichever of `a`/`b` represents more forward progress. `failed` is
 * treated as *less* advanced than any state it could have followed (a
 * failure after `printing` doesn't erase the fact that printing was
 * reached) but still more advanced than having never been claimed at all;
 * callers generally only compare a local record's last-known state against
 * a state they've just independently re-observed (e.g. from the spooler),
 * not two arbitrary states.
 */
export function moreAdvancedState(a: JobState, b: JobState): JobState {
  if (a === b) return a;
  const rankA = a === "failed" ? 0.5 : PROGRESS_RANK[a];
  const rankB = b === "failed" ? 0.5 : PROGRESS_RANK[b];
  return rankA >= rankB ? a : b;
}
