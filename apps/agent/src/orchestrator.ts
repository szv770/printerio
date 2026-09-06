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
import { handleCommand } from "./commands.js";
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
      jobQueue.rememberQueueForProfile(dl.printRequest.printerProfileId, dl.printRequest.windowsQueueName);
      jobQueue.upsertJob(claimable.jobId, { state: "downloading", windowsQueueName: dl.printRequest.windowsQueueName });

      const localFileName = `${claimable.jobId}-${sanitizeFileName(dl.fileName)}`;
      const localFilePath = path.join(config.localStoragePath, "downloads", localFileName);
      await downloadJobFile(dl.downloadUrl, localFilePath, jobLogger);
      jobQueue.upsertJob(claimable.jobId, { state: "downloaded", localFilePath });
      await safeReportStatus(claimable.jobId, "downloaded");

      // --- Print ---
      jobQueue.upsertJob(claimable.jobId, { state: "printing" });
      await safeReportStatus(claimable.jobId, "printing");

      const settingsString = buildPrintSettingsString({
        colorMode: dl.printRequest.colorMode,
        duplex: dl.printRequest.duplex,
        paperSize: dl.printRequest.paperSize,
        copies: dl.printRequest.copies,
        // The cloud overrides this only for a booklet job (forced
        // "noscale" - PrintOS has already imposed and independently scaled
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

  async function pollClaimableJobs(): Promise<void> {
    let jobs: ClaimableJob[];
    try {
      jobs = await cloudClient.getClaimableJobs();
    } catch (err) {
      logger.warn("could not fetch claimable jobs this cycle", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const job of jobs) {
      await processJob(job);
    }
  }

  async function pollCommands(): Promise<void> {
    let commands;
    try {
      commands = await cloudClient.getCommands();
    } catch (err) {
      logger.warn("could not fetch remote commands this cycle", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const envelope of commands) {
      try {
        const result = await handleCommand(envelope, {
          localStoragePath: config.localStoragePath,
          spoolerMonitor,
          printerManager,
          jobQueue,
          logger,
          refreshHeartbeatNow: () => healthMonitor.sendHeartbeat(),
          scheduleServiceRestart: () => {
            restartRequested = true;
          },
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
      logger.warn("RESTART_AGENT_SERVICE: exiting process now so the service manager can relaunch it");
      // Give the ack request above a moment to actually flush over the network.
      await sleep(1000);
      process.exit(1);
    }
  }

  async function runOnce(): Promise<void> {
    await healthMonitor.sendHeartbeat().catch((err) => logger.error("unexpected heartbeat error", { error: String(err) }));
    await pollCommands().catch((err) => logger.error("unexpected command-poll error", { error: String(err) }));
    await pollClaimableJobs().catch((err) => logger.error("unexpected job-poll error", { error: String(err) }));
  }

  return {
    async start(): Promise<void> {
      logger.info("agent starting", { pollIntervalSeconds: config.pollIntervalSeconds });
      await recoverInFlightJobs().catch((err) =>
        logger.error("startup reconciliation of in-flight jobs failed - continuing anyway", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      while (!stopped) {
        await runOnce();
        await sleep(config.pollIntervalSeconds * 1000);
      }
    },
    stop(): void {
      stopped = true;
    },
  };
}
