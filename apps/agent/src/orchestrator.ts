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

import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
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
import { checkRawTarget as defaultCheckRawTarget, type RawTargetCheck } from "./raw-host-policy.js";
import { RAW_DEFERRED_STATUSES, RAW_SUCCESS_STATUSES, executeRawPrint, type RawTimeouts } from "./raw-print-executor.js";
import { PROFILE_COOLDOWN_MS, decideDownloadFailure, decideRawFailure, type WaitKind } from "./retry-policy.js";
import { handleCommand } from "./commands.js";
import { createSelfUpdateDeps, performSelfUpdate } from "./self-update.js";
import { CloudApiError, DownloadValidationError, PrintExecutionError, SpoolerError, TransientDownloadError } from "./errors.js";
import type { Logger } from "./logger.js";

export interface OrchestratorDeps {
  config: AgentConfig;
  cloudClient: CloudClient;
  jobQueue: JobQueue;
  printerManager: PrinterManager;
  spoolerMonitor: SpoolerMonitor;
  healthMonitor: HealthMonitor;
  logger: Logger;
  /** Clock, injectable for tests (the per-printer cooldown). */
  now?: () => number;
  /** Raw sender, injectable for tests; defaults to the real TCP sender. */
  rawPrint?: typeof executeRawPrint;
  /** Raw connect/write timeouts, injectable for tests. */
  rawTimeouts?: RawTimeouts;
  /** Decides whether a raw target may be sent to (private-LAN only, optional allow-list); injectable for tests. */
  checkRawTarget?: (target: { host: string; port: number }) => Promise<RawTargetCheck>;
}

/** What one processJob() call tells its caller (the poll loop). */
export interface ProcessOutcome {
  /** The job could not be handed to the printer, so this printer profile gets a short cooldown. */
  printerNotAvailable?: boolean;
  /** The raw bytes reached the printer: the printer is there, so any cooldown is cleared. */
  sent?: boolean;
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
  let res: Response;
  try {
    res = await fetch(downloadUrl);
  } catch (err) {
    // Says nothing about the job: the network or the storage service is down. The job waits instead of failing.
    throw new TransientDownloadError(`download request could not be made: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    throw new TransientDownloadError(`download request failed with status ${res.status}`);
  }
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
  const now = deps.now ?? Date.now;
  const rawPrint = deps.rawPrint ?? executeRawPrint;
  const checkRawTarget =
    deps.checkRawTarget ?? ((target: { host: string; port: number }) => defaultCheckRawTarget(target, { allowedHosts: config.rawAllowedHosts }));
  let stopped = false;
  let restartRequested = false;
  /** printerProfileId -> epoch ms until which its queued jobs are left alone (see PROFILE_COOLDOWN_MS). */
  const profileCooldownUntil = new Map<string, number>();

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

  /**
   * Hands a still-`claimed` job back to the queue ("waiting for the printer") instead of failing it. The web app
   * applies the backoff and, once the job has been unprintable for the whole window, fails it itself. Never
   * throws. 409 (no longer ours / already released) means there is nothing left to do; 404 is an older web app
   * without the endpoint, so the job is reported failed exactly as it always was.
   */
  async function releaseJobToQueue(jobId: string, kind: WaitKind, reason: string, jobLogger: Logger): Promise<void> {
    try {
      const r = await cloudClient.releaseJob(jobId, kind, reason);
      jobQueue.removeJob(jobId);
      if (r.outcome === "waiting") {
        jobLogger.warn("printer not available - job released back to the queue to wait", { kind, tries: r.tries, retryAt: r.retryAt, reason });
      } else {
        jobLogger.error("job has been waiting for the printer too long - the web app marked it failed (owner can Try again)", { kind, reason });
      }
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 409) {
        jobQueue.removeJob(jobId);
        jobLogger.info("job could not be released because it is no longer ours - nothing more to do", { code: err.code });
        return;
      }
      if (err instanceof CloudApiError && err.status === 404) {
        jobLogger.warn("web app has no release endpoint (older version) - reporting the job failed as before", { reason });
        jobQueue.upsertJob(jobId, { state: "failed", lastError: reason });
        await safeReportStatus(jobId, "failed", reason);
        return;
      }
      // Cannot tell the web app: the lease will simply expire and the sweep returns the job to the queue.
      jobQueue.removeJob(jobId);
      jobLogger.error("could not release the job back to the queue - its lease will expire naturally", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reports the remaining statuses of a job whose document has already been sent, in order, persisting progress after
   * each one. Stops quietly on a network/server problem (the next poll tries again); drops the record when the web app
   * says the job is no longer ours (409/403/404: e.g. the sweep re-queued it), so it is never retried for ever.
   */
  async function driveSentReports(jobId: string, jobLogger: Logger): Promise<void> {
    for (;;) {
      const rec = jobQueue.getJob(jobId);
      const next = rec?.sentUnreported?.[0];
      if (!rec || !next) return;
      const sentChain = next === "submitted_to_spooler" || next === "completed";
      try {
        await cloudClient.reportStatus(
          jobId,
          next as Parameters<CloudClient["reportStatus"]>[1],
          sentChain ? "sent to printer raw port" : undefined,
          sentChain ? { bytesSent: rec.bytesSent } : undefined,
        );
      } catch (err) {
        if (err instanceof CloudApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          jobLogger.warn("web app no longer accepts reports for a job that was already sent - dropping the local record", { status: err.status, code: err.code, next });
          jobQueue.removeJob(jobId);
        } else {
          jobLogger.warn("could not report a job that was already sent - will try again on the next poll", {
            next,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      const rest = (rec.sentUnreported ?? []).slice(1);
      if (rest.length === 0) {
        jobQueue.upsertJob(jobId, { state: "completed", sentUnreported: [] }); // completed prunes the record
        return;
      }
      jobQueue.upsertJob(jobId, { sentUnreported: rest });
    }
  }

  async function redriveUnreported(): Promise<void> {
    for (const record of jobQueue.listActiveJobs()) {
      if (record.sentUnreported && record.sentUnreported.length > 0) {
        await driveSentReports(record.jobId, logger.child({ jobId: record.jobId }));
      }
    }
  }

  async function processJob(claimable: ClaimableJob): Promise<ProcessOutcome> {
    const procOutcome: ProcessOutcome = {};
    const jobLogger = logger.child({ jobId: claimable.jobId, printerProfileId: claimable.printerProfileId });

    // --- Claim ---
    let leaseExpiresAt: string;
    try {
      const claimResult = await cloudClient.claimJob(claimable.jobId);
      if (!claimResult.ok) {
        jobLogger.info("job already claimed elsewhere - skipping", { reason: claimResult.reason });
        return procOutcome;
      }
      leaseExpiresAt = claimResult.leaseExpiresAt;
    } catch (err) {
      jobLogger.warn("claim failed (network/API) - will retry on a future poll", {
        error: err instanceof Error ? err.message : String(err),
      });
      return procOutcome;
    }

    const existing = jobQueue.getJob(claimable.jobId);
    jobQueue.upsertJob(claimable.jobId, {
      printerProfileId: claimable.printerProfileId,
      jobNumber: claimable.jobNumber,
      state: "claimed",
      leaseExpiresAt,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
    });

    // The downloaded PDF is only needed until the job leaves this machine (SumatraPDF has read it / the raw
    // socket has flushed it); a retry downloads a fresh copy, so it is always removed when this job is done.
    let downloadedPath: string | undefined;
    // True while the web app still has this job as `claimed`: the only state it can be released from. We ask for
    // that (keepClaimed); an older web app ignores the request and has already moved the job to `downloading`.
    let holdsClaim = false;
    try {
      // --- Download ---
      const dl = await cloudClient.getDownloadUrl(claimable.jobId, { keepClaimed: true });
      holdsClaim = dl.jobStatus === "claimed";
      if (!dl.printRequest.raw) {
        jobQueue.rememberQueueForProfile(dl.printRequest.printerProfileId, dl.printRequest.windowsQueueName);
      }
      // A raw job stays `claimed` (locally and in the cloud) until its bytes have really been sent; everything
      // else moves on as it always did.
      const deferRawReports = holdsClaim && !!dl.printRequest.raw;
      if (!deferRawReports) {
        jobQueue.upsertJob(claimable.jobId, { state: "downloading", windowsQueueName: dl.printRequest.windowsQueueName });
        if (holdsClaim) await safeReportStatus(claimable.jobId, "downloading");
      } else {
        jobQueue.upsertJob(claimable.jobId, { windowsQueueName: dl.printRequest.windowsQueueName });
      }

      const localFileName = `${claimable.jobId}-${sanitizeFileName(dl.fileName)}`;
      const localFilePath = path.join(config.localStoragePath, "downloads", localFileName);
      downloadedPath = localFilePath;
      await downloadJobFile(dl.downloadUrl, localFilePath, jobLogger);
      if (!deferRawReports) {
        jobQueue.upsertJob(claimable.jobId, { state: "downloaded", localFilePath });
        await safeReportStatus(claimable.jobId, "downloaded");

        // --- Print ---
        jobQueue.upsertJob(claimable.jobId, { state: "printing" });
        await safeReportStatus(claimable.jobId, "printing");
      } else {
        jobQueue.upsertJob(claimable.jobId, { localFilePath });
      }

      if (dl.printRequest.raw) {
        // Raw-port path: no SumatraPDF, no spooler, nothing to identify or
        // monitor. Flushed + closed socket == completed.
        //
        // A printer that is off, offline, busy or jammed is NOT a failed job (the raw port buffers data and
        // prints when ready), so while the job is still `claimed` a send that cannot complete is released back
        // to the queue to wait (retry-policy.ts has the decision table). Only a job that can never print fails.
        //
        // The host:port came from the cloud; only private-LAN printers are ever written to (raw-host-policy.ts,
        // security review F8). A refusal is permanent for this job - it fails with the reason - and the address
        // that was checked is the one connected to, so a DNS answer cannot change in between.
        const target = await checkRawTarget({ host: dl.printRequest.raw.host, port: dl.printRequest.raw.port });
        if (!target.ok) {
          jobLogger.error("raw print refused: target not allowed", { host: dl.printRequest.raw.host, port: dl.printRequest.raw.port, reason: target.reason });
          jobQueue.upsertJob(claimable.jobId, { state: "failed", lastError: target.reason });
          await safeReportStatus(claimable.jobId, "failed", `raw print: ${target.reason}`);
          return procOutcome;
        }
        const result = await rawPrint({
          raw: { ...dl.printRequest.raw, host: target.host, port: target.port },
          request: dl.printRequest,
          pdf: readFileSync(localFilePath),
          timeouts: deps.rawTimeouts,
        });
        if (!result.ok) {
          const decision = holdsClaim ? decideRawFailure(result.failure) : ({ action: "fail" } as const);
          if (decision.action === "release") {
            jobLogger.warn("raw print could not reach the printer", { reason: result.reason, failure: result.failure });
            procOutcome.printerNotAvailable = true;
            await releaseJobToQueue(claimable.jobId, decision.kind, result.reason, jobLogger);
            return procOutcome;
          }
          jobLogger.error("raw print failed", { reason: result.reason });
          jobQueue.upsertJob(claimable.jobId, { state: "failed", lastError: result.reason });
          await safeReportStatus(claimable.jobId, "failed", `raw print: ${result.reason}`);
          return procOutcome;
        }
        procOutcome.sent = true;
        // The bytes are at the printer. Record that BEFORE the first report, so that if the web app cannot be
        // reached (or this process dies) the job is never released or sent again - only the reports are re-driven
        // (driveSentReports). Kept-claimed jobs report the whole chain now; legacy jobs already reported
        // downloaded + printing before the send.
        jobQueue.upsertJob(claimable.jobId, {
          sentUnreported: [...(holdsClaim ? RAW_DEFERRED_STATUSES : RAW_SUCCESS_STATUSES)],
          bytesSent: result.bytesSent,
        });
        await driveSentReports(claimable.jobId, jobLogger);
        jobLogger.info("job sent to the printer (raw port)", { bytesSent: result.bytesSent });
        return procOutcome;
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
        return procOutcome;
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
      // A document that could not be fetched because the network/storage is down says nothing about the job:
      // while it is still `claimed` it waits instead of failing.
      if (err instanceof TransientDownloadError && holdsClaim) {
        const decision = decideDownloadFailure({ kind: "transient" });
        if (decision.action === "release") {
          jobLogger.warn("could not fetch the document - releasing the job to wait", { error: err.message });
          await releaseJobToQueue(claimable.jobId, decision.kind, err.message, jobLogger);
          return procOutcome;
        }
      }
      // Catch-all: ANY failure anywhere in claim->download->print->monitor
      // becomes a reported `failed` status, never an uncaught exception
      // (docs/architecture.md sec 17).
      const message = err instanceof Error ? err.message : String(err);
      const details =
        err instanceof PrintExecutionError || err instanceof SpoolerError ? err.details : undefined;
      jobLogger.error("job failed", { error: message, details });
      jobQueue.upsertJob(claimable.jobId, { state: "failed", lastError: message });
      await safeReportStatus(claimable.jobId, "failed", message, details);
    } finally {
      if (downloadedPath) {
        for (const p of [downloadedPath, `${downloadedPath}.partial`]) {
          try {
            rmSync(p, { force: true });
          } catch (err) {
            jobLogger.warn("could not delete the downloaded job file", { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }
    return procOutcome;
  }

  async function recoverInFlightJobs(): Promise<void> {
    for (const record of jobQueue.listActiveJobs()) {
      const jobLogger = logger.child({ jobId: record.jobId });
      // Sent to the printer before we died: only the reports are missing. Never release or fail it (a re-send prints twice).
      if (record.sentUnreported && record.sentUnreported.length > 0) {
        jobLogger.info("a job that was already sent to the printer is missing its status reports - sending them now");
        await driveSentReports(record.jobId, jobLogger);
        continue;
      }
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

      // Still `claimed` (a raw job being sent when we died): nothing is known to have reached the printer, and
      // `claimed` is the one state a job can be released from, so it goes back to the queue to wait rather than
      // failing. (If the crash came mid-send the printer may have part of it; the owner decided waiting wins.)
      if (record.state === "claimed") {
        jobLogger.info("releasing a claimed job found on restart back to the queue", { state: record.state });
        await releaseJobToQueue(record.jobId, "unknown", "agent restarted before the job was sent", jobLogger);
        continue;
      }

      // Any later pre-print state (downloading/downloaded): we can't safely
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
    // First, finish reporting any job that was already sent to the printer (before anything new is claimed).
    await redriveUnreported();
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
    // The cloud lists jobs oldest first and we keep that order, one at a time.
    for (const job of jobs) {
      const until = profileCooldownUntil.get(job.printerProfileId);
      if (until !== undefined) {
        if (now() < until) {
          logger.debug("printer was not available a moment ago - leaving its queued jobs alone for now", { jobId: job.jobId, printerProfileId: job.printerProfileId });
          continue;
        }
        profileCooldownUntil.delete(job.printerProfileId);
      }
      const outcome = await processJob(job);
      if (outcome.printerNotAvailable) profileCooldownUntil.set(job.printerProfileId, now() + PROFILE_COOLDOWN_MS);
      else if (outcome.sent) profileCooldownUntil.delete(job.printerProfileId);
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
    // Exposed so the release/cooldown behaviour can be tested without the sleeping poll loop.
    processJob,
    pollClaimableJobs,
    recoverInFlightJobs,
  };
}
