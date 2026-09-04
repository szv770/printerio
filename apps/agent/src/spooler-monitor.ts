/**
 * Windows spooler job monitoring/cancellation.
 *
 * Hard rule (docs/architecture.md sec 11, known-limitations.md): every read
 * or cancel of a specific print job passes BOTH the exact printer/queue name
 * and the job id together - never an ID-only lookup across all printers.
 * `getPrintJobStatus` and `cancelPrintJob` below both require a queue name
 * (validated non-empty) as well as a job id (validated as a positive
 * integer) and there is no code path in this module that omits the queue
 * name.
 *
 * `listQueueJobs` is the one exception worth calling out: it IS scoped to a
 * single named queue (never "all printers"), and is used only transiently by
 * `findNewJobId` to identify, by diffing a before/after snapshot, which job
 * id the agent's own just-submitted print became - SumatraPDF's exit code
 * does not itself report the Windows spooler job id it was assigned. Once
 * identified, every subsequent read/cancel for that job uses the strict
 * queue+id pair.
 */

import {
  ensureScriptFile,
  runPowerShellFile,
  parseScriptJson,
} from "./ps-runner.js";
import {
  LIST_PRINT_JOBS_PS1,
  GET_PRINT_JOB_PS1,
  REMOVE_PRINT_JOB_PS1,
} from "./powershell-scripts.js";
import type { Logger } from "./logger.js";
import { SpoolerError } from "./errors.js";

export function validateQueueName(queueName: string): void {
  if (!queueName || typeof queueName !== "string" || queueName.trim().length === 0) {
    throw new SpoolerError("queue name must be a non-empty string");
  }
  if (queueName.length > 256) {
    throw new SpoolerError("queue name is implausibly long - refusing");
  }
}

export function validateJobId(jobId: number): void {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new SpoolerError(`job id must be a positive integer, got ${jobId}`);
  }
}

export interface QueueJobSummary {
  id: number;
  documentName: string;
  submittedTime: string;
}

interface ListJobsResult {
  ok: boolean;
  jobs: QueueJobSummary[];
  error?: string;
}

interface GetJobResult {
  ok: boolean;
  found: boolean;
  id?: number;
  jobStatus?: string;
  documentName?: string;
  totalPages?: number;
  pagesPrinted?: number;
  error?: string;
}

interface RemoveJobResult {
  ok: boolean;
  error?: string;
}

/** Windows JOB_STATUS_* flags that unambiguously mean the job cannot proceed. See docs/known-limitations.md. */
const FAILURE_STATUS_MARKERS = ["error", "offline", "paperout", "paperjam", "userintervention", "blocked_devq"];

/** JOB_STATUS_PRINTED means "left the spooler cleanly" - NOT proof of physical output (docs/known-limitations.md). */
const CLEAN_EXIT_STATUS_MARKERS = ["printed", "complete", "deleting"];

export type SpoolerJobClassification = "in_progress" | "clean_exit" | "failure" | "not_found";

export function classifyJobStatus(rawStatus: string): SpoolerJobClassification {
  const s = rawStatus.toLowerCase();
  if (FAILURE_STATUS_MARKERS.some((m) => s.includes(m))) return "failure";
  if (CLEAN_EXIT_STATUS_MARKERS.some((m) => s.includes(m))) return "clean_exit";
  return "in_progress";
}

export interface SpoolerMonitor {
  listQueueJobs(queueName: string): Promise<QueueJobSummary[]>;
  getPrintJobStatus(queueName: string, jobId: number): Promise<GetJobResult>;
  cancelPrintJob(queueName: string, jobId: number): Promise<void>;
  /** Polls until the job leaves the spooler cleanly, hits a failure status, disappears, or times out. Never throws for a printing-related failure - always resolves to a classified outcome. */
  pollUntilTerminal(
    queueName: string,
    jobId: number,
    opts: { pollIntervalMs: number; timeoutSeconds: number },
  ): Promise<{ outcome: "completed" | "failed"; reason: string; rawStatus?: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSpoolerMonitor(localStoragePath: string, logger: Logger): SpoolerMonitor {
  async function listQueueJobs(queueName: string): Promise<QueueJobSummary[]> {
    validateQueueName(queueName);
    const scriptPath = ensureScriptFile("list-print-jobs", LIST_PRINT_JOBS_PS1, localStoragePath);
    const result = await runPowerShellFile(scriptPath, { args: ["-PrinterName", queueName] }, logger);
    const parsed = parseScriptJson<ListJobsResult>(result, "list-print-jobs");
    if (!parsed.ok) {
      throw new SpoolerError(`Get-PrintJob (list) failed for queue "${queueName}"`, { error: parsed.error });
    }
    return parsed.jobs;
  }

  async function getPrintJobStatus(queueName: string, jobId: number): Promise<GetJobResult> {
    validateQueueName(queueName);
    validateJobId(jobId);
    const scriptPath = ensureScriptFile("get-print-job", GET_PRINT_JOB_PS1, localStoragePath);
    const result = await runPowerShellFile(
      scriptPath,
      { args: ["-PrinterName", queueName, "-JobId", String(jobId)] },
      logger,
    );
    const parsed = parseScriptJson<GetJobResult>(result, "get-print-job");
    if (!parsed.ok) {
      throw new SpoolerError(`Get-PrintJob failed for queue "${queueName}" job ${jobId}`, { error: parsed.error });
    }
    return parsed;
  }

  async function cancelPrintJob(queueName: string, jobId: number): Promise<void> {
    validateQueueName(queueName);
    validateJobId(jobId);
    const scriptPath = ensureScriptFile("remove-print-job", REMOVE_PRINT_JOB_PS1, localStoragePath);
    const result = await runPowerShellFile(
      scriptPath,
      { args: ["-PrinterName", queueName, "-JobId", String(jobId)] },
      logger,
    );
    const parsed = parseScriptJson<RemoveJobResult>(result, "remove-print-job");
    if (!parsed.ok) {
      // Treat "job not found" as a benign no-op (it may have already finished/left the queue) rather than a hard error.
      const alreadyGone = /cannot find|does not exist|not found/i.test(parsed.error ?? "");
      if (!alreadyGone) {
        throw new SpoolerError(`Remove-PrintJob failed for queue "${queueName}" job ${jobId}`, {
          error: parsed.error,
        });
      }
      logger.info("cancel target already gone from spooler - treating as cancelled", { queueName, jobId });
    }
  }

  async function pollUntilTerminal(
    queueName: string,
    jobId: number,
    opts: { pollIntervalMs: number; timeoutSeconds: number },
  ): Promise<{ outcome: "completed" | "failed"; reason: string; rawStatus?: string }> {
    const deadline = Date.now() + opts.timeoutSeconds * 1000;
    let sawJobAtLeastOnce = false;

    // Grace period for "not found immediately" - a brand-new job can take a
    // moment to register, and a trivial 1-page local job can also finish and
    // leave the queue almost immediately, so "not found" is ambiguous on the
    // very first poll(s).
    const graceDeadline = Date.now() + Math.min(5000, opts.timeoutSeconds * 1000);

    while (Date.now() < deadline) {
      let status: GetJobResult;
      try {
        status = await getPrintJobStatus(queueName, jobId);
      } catch (err) {
        logger.warn("spooler status poll failed - will retry", {
          queueName,
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(opts.pollIntervalMs);
        continue;
      }

      if (!status.found) {
        if (sawJobAtLeastOnce) {
          // We saw it printing/queued before and now it's gone -> left the
          // spooler cleanly. Per docs/known-limitations.md this means
          // "submitted_to_spooler -> completed" (spooler-level), NOT
          // confirmed physical output.
          return { outcome: "completed", reason: "job left the spooler queue after being observed" };
        }
        if (Date.now() < graceDeadline) {
          await sleep(Math.min(300, opts.pollIntervalMs));
          continue;
        }
        // Never observed the job at all within the grace period - honest
        // failure rather than a guessed success (see orchestrator.ts).
        return {
          outcome: "failed",
          reason: `job ${jobId} was never observed on queue "${queueName}" - could not confirm spooler acceptance`,
        };
      }

      sawJobAtLeastOnce = true;
      const classification = classifyJobStatus(status.jobStatus ?? "");
      if (classification === "failure") {
        return {
          outcome: "failed",
          reason: `spooler reported a failure status: ${status.jobStatus}`,
          rawStatus: status.jobStatus,
        };
      }
      if (classification === "clean_exit") {
        return {
          outcome: "completed",
          reason: `spooler status indicates the job left the queue cleanly (${status.jobStatus})`,
          rawStatus: status.jobStatus,
        };
      }
      await sleep(opts.pollIntervalMs);
    }

    return {
      outcome: "failed",
      reason: `timed out after ${opts.timeoutSeconds}s waiting for job ${jobId} on queue "${queueName}" to leave the spooler`,
    };
  }

  return { listQueueJobs, getPrintJobStatus, cancelPrintJob, pollUntilTerminal };
}

/**
 * Diffs a before/after job listing (both fetched via `listQueueJobs`, which
 * is scoped to one named queue) to identify which newly-appeared job id is
 * ours. Prefers an exact `documentName` match (SumatraPDF typically sets the
 * spooler document name to the file it was given), falling back to the most
 * recently submitted new job, and returns null (never guesses across
 * multiple equally-plausible candidates) if it can't decide.
 */
export function findNewJobId(
  before: QueueJobSummary[],
  after: QueueJobSummary[],
  documentNameHint: string,
): { jobId: number; confidence: "exact_name_match" | "most_recent" } | null {
  const beforeIds = new Set(before.map((j) => j.id));
  const candidates = after.filter((j) => !beforeIds.has(j.id));
  if (candidates.length === 0) return null;

  const exact = candidates.filter((c) => c.documentName === documentNameHint);
  if (exact.length === 1) return { jobId: exact[0]!.id, confidence: "exact_name_match" };

  const pool = exact.length > 1 ? exact : candidates;
  const mostRecent = [...pool].sort(
    (a, b) => new Date(b.submittedTime).getTime() - new Date(a.submittedTime).getTime(),
  )[0];
  return mostRecent ? { jobId: mostRecent.id, confidence: "most_recent" } : null;
}
