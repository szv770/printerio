/**
 * Main loop: poll claimable jobs -> claim -> download -> print -> monitor ->
 * report. Every stage is wrapped so ANY failure (printer offline, malformed
 * file, locked file, PowerShell failure, network drop, disk full, ...)
 * becomes a reported `failed` status, NEVER an uncaught exception that
 * crashes the process (docs/architecture.md sec 17).
 *
 * This module also owns the heartbeat and remote-command polling ticks,
 * since docs/agent-api.md describes all three (heartbeat, claimable jobs,
 * commands) as polled on the same short interval rather than three
 * independent connections.
 */

import { createWriteStream, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import type { CloudClient, ClaimableJob } from "./cloud-client.js";
import type { JobQueue } from "./job-queue.js";
import type { PrinterManager } from "./printer-manager.js";
import type { SpoolerMonitor } from "./spooler-monitor.js";
import { findNewJobId } from "./spooler-monitor.js";
import type { HealthMonitor } from "./health-monitor.js";
import { buildPrintSettingsString, executePrint } from "./print-executor.js";
import { RAW_SUCCESS_STATUSES, executeRawPrint } from "./raw-print-executor.js";
import { handleCommand } from "./commands.js";
import { createSelfUpdateDeps, performSelfUpdate } from "./self-update.js";
import { DownloadValidationError, PrintExecutionError, SpoolerError } from "./errors.js";
import type { Logger } from "./logger.js";

export interface OrchestratorDeps {
  config: AgentConfig;
  cloudClient: CloudClient;
  jobQueue: JobQueue;
  printerManager: PrinterManager;
  spoolerMonitor: SpoolerMonitor;
  healthMonitor: HealthMonitor;
  logger: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Outcome of one `runOnce()` cycle, in terms of the three cloud-touching
 * sub-polls it runs (heartbeat, commands, claimable jobs) - each of which is
 * already independently retried by cloud-client.ts's `sendWithRetry`, so by
 * the time any of them reports failure here, that per-request retry budget
 * is already exhausted.
 *
 * - "success": all three reached the cloud.
 * - "failure": all three failed to reach the cloud - this is the "the whole
 *   backend is unreachable" case (sustained outage, agent's own network
 *   down, DNS gone, etc), and is the ONLY outcome that escalates the outer
 *   poll interval (see computeNextPollDelayMs). A single endpoint being
 *   flaky while the other two succeed is deliberately NOT treated the same
 *   as a total outage - e.g. heartbeat and claimable-jobs succeeding while
 *   only the commands poll 5xx's once in a while is a partial, likely
 *   transient, condition that cloud-client.ts's own per-request retries
 *   already absorb most of; escalating the whole fleet's cadence over that
 *   would be overreacting to noise instead of a real outage.
 * - "partial": some succeeded and some failed - holds the current backoff
 *   state steady (neither escalates further nor resets to the base
 *   interval) until a cycle resolves fully one way or the other.
 */
export type CycleOutcome = "success" | "partial" | "failure";

/** Classifies a cycle from its three sub-poll results. Exported for unit testing in isolation from the real network/heartbeat/printer plumbing. */
export function classifyCycleOutcome(results: readonly boolean[]): CycleOutcome {
  if (results.every((ok) => ok)) return "success";
  if (results.every((ok) => !ok)) return "failure";
  return "partial";
}

/**
 * Updates the consecutive-full-cycle-failure counter given this cycle's
 * outcome. A "failure" cycle increments it (driving computeNextPollDelayMs's
 * doubling further); a "success" cycle resets it to 0 immediately (no
 * gradual ramp-down - the instant the cloud is reachable again, the agent
 * snaps straight back to its normal configured cadence); a "partial" cycle
 * leaves it untouched, holding whatever backoff level was already in effect.
 */
export function nextConsecutiveFailures(outcome: CycleOutcome, current: number): number {
  if (outcome === "failure") return current + 1;
  if (outcome === "success") return 0;
  return current;
}

/**
 * Pure computation of the outer poll loop's next sleep duration (ms) given
 * how many consecutive full-cycle failures have just occurred.
 *
 * - 0 failures -> exactly `baseIntervalSeconds` (today's unchanged happy-path
 *   cadence - this function must be a no-op for a healthy Agent).
 * - Each additional consecutive failure doubles the delay from there
 *   (1 -> x2, 2 -> x4, 3 -> x8, ...), capped at `maxIntervalSeconds` so a
 *   long outage never pushes an Agent out to some absurd multi-hour sleep it
 *   can't be nudged out of short of a restart.
 *
 * Exported standalone (no cloud-client/health-monitor/logger dependency) so
 * it can be unit tested the way job-queue.ts's `moreAdvancedState` and
 * commands.ts's allow-list are - see test/orchestrator.test.ts.
 */
export function computeNextPollDelayMs(
  consecutiveFailures: number,
  baseIntervalSeconds: number,
  maxIntervalSeconds: number,
): number {
  const baseMs = baseIntervalSeconds * 1000;
  if (consecutiveFailures <= 0) return baseMs;
  const maxMs = maxIntervalSeconds * 1000;
  const scaledMs = baseMs * 2 ** consecutiveFailures;
  return Math.min(scaledMs, maxMs);
}

/** Strips any directory component from a cloud-supplied file name before it ever touches a local path - defense in depth against a malformed/hostile fileName. */
function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "job.pdf";
}

async function downloadJobFile(
  downloadUrl: string,
  destPath: string,
  logger: Logger,
): Promise<{ bytesWritten: number }> {
  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) {
    throw new DownloadValidationError(`download request failed with status ${res.status}`);
  }

  mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.partial`;
  const expectedLength = res.headers.get("content-length");

  // Stream to disk rather than buffering the whole file in memory - matters
  // for the "large job" case in the physical validation checklist (README).
  await new Promise<void>((resolve, reject) => {
    const fileStream = createWriteStream(tmpPath);
    const nodeStream = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    nodeStream.pipe(fileStream);
    nodeStream.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", resolve);
  });

  const bytesWritten = statSync(tmpPath).size;
  if (bytesWritten === 0) {
    unlinkSync(tmpPath);
    throw new DownloadValidationError("downloaded file is empty (0 bytes)");
  }
  if (expectedLength && Number(expectedLength) !== bytesWritten) {
    logger.warn("downloaded file size does not match Content-Length - continuing, but flagging it", {
      expectedLength,
      bytesWritten,
    });
  }

  // Cheap-but-real validation: a genuine PDF starts with "%PDF-". Catches a
  // truncated/HTML-error-page download before it ever reaches SumatraPDF.
  const head = readFileSync(tmpPath, { encoding: "latin1", flag: "r" }).slice(0, 5);
  if (head !== "%PDF-") {
    unlinkSync(tmpPath);
    throw new DownloadValidationError('downloaded file does not start with the PDF magic bytes ("%PDF-")');
  }

  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, destPath);
  return { bytesWritten };
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { config, cloudClient, jobQueue, printerManager, spoolerMonitor, healthMonitor, logger } = deps;
  let stopped = false;
  let restartRequested = false;

  async function safeReportStatus(jobId: string, status: Parameters<CloudClient["reportStatus"]>[1], message?: string, metadata?: Record<string, unknown>) {
    try {
      await cloudClient.reportStatus(jobId, status, message, metadata);
    } catch (err) {
      // We tried our best to tell the cloud; if even that fails (network
      // down), the lease will simply expire server-side and the job
      // returns to the pool (docs/architecture.md sec 13/17) - this must
      // never throw back into the caller.
      logger.error("failed to report job status to cloud - lease will expire naturally if this persists", {
        jobId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function processJob(claimable: ClaimableJob): Promise<void> {
    const jobLogger = logger.child({ jobId: claimable.jobId, printerProfileId: claimable.printerProfileId });

    // --- Claim ---
    let leaseExpiresAt: string;
    try {
      const claimResult = await cloudClient.claimJob(claimable.jobId);
      if (!claimResult.ok) {
        jobLogger.info("job already claimed elsewhere - skipping", { reason: claimResult.reason });
        return;
      }
      leaseExpiresAt = claimResult.leaseExpiresAt;
    } catch (err) {
      jobLogger.warn("claim failed (network/API) - will retry on a future poll", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const existing = jobQueue.getJob(claimable.jobId);
    jobQueue.upsertJob(claimable.jobId, {
      printerProfileId: claimable.printerProfileId,
      jobNumber: claimable.jobNumber,
      state: "claimed",
      leaseExpiresAt,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
    });

    try {
      // --- Download ---
      const dl = await cloudClient.getDownloadUrl(claimable.jobId);
      if (!dl.printRequest.raw) {
        jobQueue.rememberQueueForProfile(dl.printRequest.printerProfileId, dl.printRequest.windowsQueueName);
      }
      jobQueue.upsertJob(claimable.jobId, { state: "downloading", windowsQueueName: dl.printRequest.windowsQueueName });

      const localFileName = `${claimable.jobId}-${sanitizeFileName(dl.fileName)}`;
      const localFilePath = path.join(config.localStoragePath, "downloads", localFileName);
      await downloadJobFile(dl.downloadUrl, localFilePath, jobLogger);
      jobQueue.upsertJob(claimable.jobId, { state: "downloaded", localFilePath });
      await safeReportStatus(claimable.jobId, "downloaded");

      // --- Print ---
      jobQueue.upsertJob(claimable.jobId, { state: "printing" });
      await safeReportStatus(claimable.jobId, "printing");

      if (dl.printRequest.raw) {
        // Raw-port path: no SumatraPDF, no spooler, nothing to identify or
        // monitor. Flushed + closed socket == completed. Failure is terminal
        // (reported once, never retried by the agent).
        const result = await executeRawPrint({
          raw: dl.printRequest.raw,
          request: dl.printRequest,
          pdf: readFileSync(localFilePath),
        });
        if (!result.ok) {
          jobLogger.error("raw print failed", { reason: result.reason });
          jobQueue.upsertJob(claimable.jobId, { state: "failed", lastError: result.reason });
          await safeReportStatus(claimable.jobId, "failed", `raw print: ${result.reason}`);
          return;
        }
        jobQueue.upsertJob(claimable.jobId, { state: "completed" });
        for (const status of RAW_SUCCESS_STATUSES) {
          await safeReportStatus(claimable.jobId, status, "sent to printer raw port", { bytesSent: result.bytesSent });
        }
        jobLogger.info("job completed (raw port)", { bytesSent: result.bytesSent });
        return;
      }

      const settingsString = buildPrintSettingsString({
        colorMode: dl.printRequest.colorMode,
        duplex: dl.printRequest.duplex,
        paperSize: dl.printRequest.paperSize,
        copies: dl.printRequest.copies,
        // The cloud overrides this only for a booklet job (forced
        // "noscale" - Printio has already imposed and independently scaled
        // every page, see apps/web/lib/pdf/imposition.ts and
        // ResolvedPrintRequest.fitMode's doc comment); every other job
        // falls back to this Agent's own configured default, unchanged from
        // before this field existed.
        fitMode: dl.printRequest.fitMode ?? config.printFitMode,
        collateMultiCopy: config.collateMultiCopy,
      });

      const before = await spoolerMonitor.listQueueJobs(dl.printRequest.windowsQueueName).catch((err) => {
        jobLogger.warn("could not snapshot queue before printing - job-id identification may be less reliable", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

      const invocation = await executePrint(
        {
          sumatraPath: config.sumatraPath,
          windowsQueueName: dl.printRequest.windowsQueueName,
          pdfPath: localFilePath,
          settingsString,
        },
        jobLogger,
      );

      if (invocation.exitCode !== 0) {
        throw new PrintExecutionError(`SumatraPDF exited with code ${invocation.exitCode}`, {
          stdout: invocation.stdout.slice(0, 2000),
          stderr: invocation.stderr.slice(0, 2000),
        });
      }

      jobQueue.upsertJob(claimable.jobId, { state: "submitted_to_spooler" });
      await safeReportStatus(claimable.jobId, "submitted_to_spooler");

      // --- Identify our spooler job id (see spooler-monitor.ts findNewJobId) ---
      let spoolerJobId: number | undefined;
      for (let attempt = 0; attempt < 5 && spoolerJobId === undefined; attempt += 1) {
        const after = await spoolerMonitor.listQueueJobs(dl.printRequest.windowsQueueName).catch(() => []);
        const identified = findNewJobId(before, after, path.basename(localFilePath));
        if (identified) {
          spoolerJobId = identified.jobId;
          jobLogger.info("identified spooler job id", { spoolerJobId, confidence: identified.confidence });
        } else {
          await sleep(300);
        }
      }

      if (spoolerJobId === undefined) {
        // Honest, conservative outcome: SumatraPDF exited 0 (spooler
        // accepted it per docs/architecture.md sec 10), but we could not
        // identify which spooler job is ours, so we cannot safely monitor
        // or cancel it later - and per docs/known-limitations.md we do not
        // fabricate a `completed` we can't back up.
        jobLogger.warn(
          "SumatraPDF exited 0 but the agent could not identify the resulting spooler job id - " +
            "reporting failed rather than guessing at completion",
        );
        await safeReportStatus(
          claimable.jobId,
          "failed",
          "print was submitted to SumatraPDF (exit 0) but the agent could not identify the resulting Windows spooler job for monitoring",
        );
        jobQueue.upsertJob(claimable.jobId, { state: "failed", lastError: "could_not_identify_spooler_job" });
        return;
      }

      jobQueue.upsertJob(claimable.jobId, { spoolerJobId });

      // --- Monitor ---
      const outcome = await spoolerMonitor.pollUntilTerminal(dl.printRequest.windowsQueueName, spoolerJobId, {
        pollIntervalMs: config.spoolerPollIntervalMs,
        timeoutSeconds: config.spoolerTimeoutSeconds,
      });

      jobQueue.upsertJob(claimable.jobId, { state: outcome.outcome, lastError: outcome.outcome === "failed" ? outcome.reason : undefined });
      await safeReportStatus(claimable.jobId, outcome.outcome, outcome.reason, { rawSpoolerStatus: outcome.rawStatus });
      jobLogger.info(`job ${outcome.outcome}`, { reason: outcome.reason });
    } catch (err) {
      // Catch-all: ANY failure anywhere in claim->download->print->monitor
      // becomes a reported `failed` status, never an uncaught exception
      // (docs/architecture.md sec 17).
      const message = err instanceof Error ? err.message : String(err);
      const details =
        err instanceof PrintExecutionError || err instanceof SpoolerError ? err.details : undefined;
      jobLogger.error("job failed", { error: message, details });
      jobQueue.upsertJob(claimable.jobId, { state: "failed", lastError: message });
      await safeReportStatus(claimable.jobId, "failed", message, details);
    }
  }

  async function recoverInFlightJobs(): Promise<void> {
    for (const record of jobQueue.listActiveJobs()) {
      const jobLogger = logger.child({ jobId: record.jobId });
      if (record.state === "printing" || record.state === "submitted_to_spooler") {
        if (record.windowsQueueName && record.spoolerJobId !== undefined) {
          jobLogger.info("resuming spooler monitoring for an in-flight job found on restart", {
            windowsQueueName: record.windowsQueueName,
            spoolerJobId: record.spoolerJobId,
          });
          try {
            const outcome = await spoolerMonitor.pollUntilTerminal(record.windowsQueueName, record.spoolerJobId, {
              pollIntervalMs: config.spoolerPollIntervalMs,
              timeoutSeconds: config.spoolerTimeoutSeconds,
            });
            jobQueue.upsertJob(record.jobId, { state: outcome.outcome });
            await safeReportStatus(record.jobId, outcome.outcome, `resumed after agent restart: ${outcome.reason}`);
            continue;
          } catch (err) {
            jobLogger.warn("failed to resume spooler monitoring after restart - reporting failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        jobQueue.upsertJob(record.jobId, { state: "failed", lastError: "agent restarted mid-print" });
        await safeReportStatus(record.jobId, "failed", "agent restarted while this job was printing and it could not be resumed");
        continue;
      }

      // Any earlier state (claimed/downloading/downloaded): we can't safely
      // assume the local file/lease is still good. Report failed and let
      // the cloud's retry/lease-expiry mechanism (docs/architecture.md sec
      // 13/17) pick it back up rather than risk a double-submission.
      jobLogger.info("dropping a pre-print in-flight job found on restart - letting the cloud's lease/retry logic recover it", {
        state: record.state,
      });
      await safeReportStatus(record.jobId, "failed", `agent restarted before printing (was in state "${record.state}")`);
      jobQueue.removeJob(record.jobId);
    }
  }

  /**
   * Returns `true` iff the claimable-jobs fetch itself reached the cloud
   * (regardless of what, if anything, happened to individual jobs
   * afterwards - a claim conflict or a single job's failure is not a cloud
   * connectivity problem, and per-job failures are already fully reported
   * via processJob's own catch-all). Returns `false` only when
   * `getClaimableJobs()` itself failed after cloud-client.ts's own retries.
   */
  async function pollClaimableJobs(): Promise<boolean> {
    // Defense in depth on top of the cloud's own refusal (see
    // HeartbeatResponse.paused / docs/agent-api.md): while an admin has this
    // Agent paused, don't even ask for work. Returns `true` because nothing
    // failed - the cloud was reached this cycle by the heartbeat that told us
    // we're paused, and treating a deliberate pause as a connectivity failure
    // would wrongly escalate the outer poll backoff (see CycleOutcome).
    if (healthMonitor.isPaused()) {
      logger.debug("agent is paused by an administrator - not polling for claimable jobs this cycle");
      return true;
    }

    let jobs: ClaimableJob[];
    try {
      jobs = await cloudClient.getClaimableJobs();
    } catch (err) {
      logger.warn("could not fetch claimable jobs this cycle", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    for (const job of jobs) {
      await processJob(job);
    }
    return true;
  }

  /**
   * Returns `true` iff the commands fetch itself reached the cloud (an
   * individual command handler throwing is already caught and acked as
   * `failed` below - that's not a connectivity problem either). Returns
   * `false` only when `getCommands()` itself failed after cloud-client.ts's
   * own retries.
   */
  async function pollCommands(): Promise<boolean> {
    let commands;
    try {
      commands = await cloudClient.getCommands();
    } catch (err) {
      logger.warn("could not fetch remote commands this cycle", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    for (const envelope of commands) {
      try {
        const result = await handleCommand(envelope, {
          localStoragePath: config.localStoragePath,
          spoolerMonitor,
          printerManager,
          jobQueue,
          logger,
          refreshHeartbeatNow: () => healthMonitor.sendHeartbeat().then(() => undefined),
          scheduleServiceRestart: () => {
            restartRequested = true;
          },
          runSelfUpdate: () => performSelfUpdate(createSelfUpdateDeps(logger)),
        });
        await cloudClient.ackCommand(envelope.id, result.status, result.result);
      } catch (err) {
        logger.error("command handling threw unexpectedly - acking as failed", {
          commandId: envelope.id,
          command: envelope.command,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          await cloudClient.ackCommand(envelope.id, "failed", { reason: "handler_exception" });
        } catch {
          // best effort
        }
      }
    }

    if (restartRequested) {
      logger.warn(
        "a restart was requested by a remote command (RESTART_AGENT_SERVICE, or a successful CHECK_FOR_UPDATE) - " +
          "exiting the process now, after the ack above, so the service manager can relaunch it",
      );
      // Give the ack request above a moment to actually flush over the network.
      await sleep(1000);
      process.exit(1);
    }
    return true;
  }

  /**
   * Runs the three polled sub-calls (heartbeat, commands, claimable jobs)
   * and classifies the cycle as a whole (see CycleOutcome doc comment).
   * None of the three sub-calls ever throws by contract, but each is still
   * wrapped in its own `.catch()` here as defense in depth (docs/
   * architecture.md sec 17: this loop must never die from an unexpected
   * exception) - a caught-here exception counts the same as that sub-call
   * reporting `false`.
   */
  async function runOnce(): Promise<CycleOutcome> {
    const heartbeatOk = await healthMonitor
      .sendHeartbeat()
      .catch((err) => {
        logger.error("unexpected heartbeat error", { error: String(err) });
        return false;
      });
    const commandsOk = await pollCommands().catch((err) => {
      logger.error("unexpected command-poll error", { error: String(err) });
      return false;
    });
    const claimableOk = await pollClaimableJobs().catch((err) => {
      logger.error("unexpected job-poll error", { error: String(err) });
      return false;
    });
    return classifyCycleOutcome([heartbeatOk, commandsOk, claimableOk]);
  }

  return {
    async start(): Promise<void> {
      logger.info("agent starting", {
        pollIntervalSeconds: config.pollIntervalSeconds,
        maxPollIntervalSeconds: config.maxPollIntervalSeconds,
      });
      await recoverInFlightJobs().catch((err) =>
        logger.error("startup reconciliation of in-flight jobs failed - continuing anyway", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      let consecutiveFailures = 0;
      // One-time-only startup jitter (see computeNextPollDelayMs/start() doc
      // comment above the loop): applied to exactly the first sleep, so a
      // fleet of Agents that all boot at the same instant (a synchronized
      // Group Policy reboot, say) don't stay phase-locked on every later
      // cycle too - without ever delaying the very first heartbeat itself,
      // which still fires immediately below like it always has.
      let appliedStartupJitter = false;

      while (!stopped) {
        const outcome = await runOnce();
        const previousConsecutiveFailures = consecutiveFailures;
        consecutiveFailures = nextConsecutiveFailures(outcome, consecutiveFailures);

        if (outcome === "success" && previousConsecutiveFailures > 0) {
          logger.info("cloud cycle fully succeeded - resetting outer poll interval to the configured base", {
            previousConsecutiveFailures,
            pollIntervalSeconds: config.pollIntervalSeconds,
          });
        }

        let delayMs = computeNextPollDelayMs(
          consecutiveFailures,
          config.pollIntervalSeconds,
          config.maxPollIntervalSeconds,
        );

        if (outcome === "failure") {
          logger.warn("cloud cycle failed entirely (heartbeat, commands, and claimable-jobs all unreachable) - backing off the outer poll interval", {
            consecutiveFailures,
            nextPollDelayMs: delayMs,
          });
        }

        if (!appliedStartupJitter) {
          appliedStartupJitter = true;
          const jitterMs = Math.floor(Math.random() * config.pollIntervalSeconds * 1000);
          logger.info("adding one-time startup jitter before the first poll sleep - avoids a synchronized fleet reboot staying phase-locked on every later cycle", {
            jitterMs,
          });
          delayMs += jitterMs;
        }

        await sleep(delayMs);
      }
    },
    stop(): void {
      stopped = true;
    },
  };
}
