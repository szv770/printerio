/**
 * Fixed switch/handler over the exact REMOTE_COMMANDS set from
 * @printio/shared (docs/architecture.md sec 12). There is no code path here
 * that accepts, `eval`s, or shells out an arbitrary string from the cloud -
 * every branch below has a hardcoded implementation, and the payload for
 * each is read only for the specific, typed fields that command expects.
 */

import { readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { REMOTE_COMMANDS, type RemoteCommand } from "@printio/shared";
import type { RemoteCommandEnvelope } from "./cloud-client.js";
import type { SpoolerMonitor } from "./spooler-monitor.js";
import type { PrinterManager } from "./printer-manager.js";
import type { JobQueue } from "./job-queue.js";
import type { Logger } from "./logger.js";
import type { SelfUpdateResult } from "./self-update.js";

export interface CommandResult {
  status: "completed" | "failed";
  result?: Record<string, unknown>;
}

export interface CommandHandlerDeps {
  localStoragePath: string;
  spoolerMonitor: SpoolerMonitor;
  printerManager: PrinterManager;
  jobQueue: JobQueue;
  logger: Logger;
  /** Refreshes and reports queue status right away (used after REFRESH_PRINTER_STATUS / RESTART_PRINT_QUEUE so the dashboard sees the effect promptly, rather than waiting for the next heartbeat interval). */
  refreshHeartbeatNow: () => Promise<void>;
  /** Schedules a controlled process exit so the OS Service Control Manager's configured recovery action relaunches the process (see windows-service.ts / README). Never called synchronously inside the handler - the ack must go out first. */
  scheduleServiceRestart: () => void;
  /**
   * Runs the fixed, hardcoded self-update sequence (self-update.ts) - injected
   * rather than called directly so tests can drive every outcome (not a git
   * checkout, git missing, pull failed, already up to date, updated) without a
   * real git remote or a real `pnpm install`.
   */
  runSelfUpdate: () => Promise<SelfUpdateResult>;
}

const REMOTE_COMMAND_SET = new Set<string>(REMOTE_COMMANDS);

function isKnownCommand(command: string): command is RemoteCommand {
  return REMOTE_COMMAND_SET.has(command);
}

/** Recursively removes files (not directories) under `dir`, returning how many were deleted. Never throws on an individual file failure - best effort, keeps going. */
function clearFilesUnder(dir: string, logger: Logger): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        count += clearFilesUnder(full, logger);
        try {
          rmdirSync(full);
        } catch {
          // directory not empty or in use - fine, leave it
        }
      } else {
        unlinkSync(full);
        count += 1;
      }
    } catch (err) {
      logger.warn("failed to remove a temp file during CLEAR_AGENT_TEMP_FILES", {
        path: full,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return count;
}

export async function handleCommand(
  envelope: RemoteCommandEnvelope,
  deps: CommandHandlerDeps,
): Promise<CommandResult> {
  const { logger } = deps;

  if (!isKnownCommand(envelope.command)) {
    // Defense in depth only - the cloud contract guarantees this never
    // happens (docs/agent-api.md), but if it ever did, the fixed switch
    // below simply has no matching case, so nothing is executed.
    logger.error("received an unrecognized remote command - ignoring", { command: envelope.command });
    return { status: "failed", result: { reason: "unknown_command" } };
  }

  logger.info("handling remote command", { command: envelope.command, commandId: envelope.id });

  switch (envelope.command) {
    case "REFRESH_PRINTER_STATUS": {
      const queues = await deps.printerManager.discoverQueues();
      await deps.refreshHeartbeatNow();
      return { status: "completed", result: { queueCount: queues.length } };
    }

    case "CANCEL_PRINT_JOB": {
      const jobId = envelope.payload?.jobId;
      if (typeof jobId !== "string" || !jobId) {
        return { status: "failed", result: { reason: "missing_job_id" } };
      }
      const record = deps.jobQueue.getJob(jobId);
      if (!record?.windowsQueueName || record.spoolerJobId === undefined) {
        // Nothing local to cancel - either already finished/reported, or
        // never reached the spooler on this agent. Not an agent-side
        // failure; the cloud is the source of truth for the job's status.
        logger.info("CANCEL_PRINT_JOB: no local spooler job on record - nothing to cancel here", { jobId });
        return { status: "completed", result: { reason: "no_local_spooler_job" } };
      }
      try {
        await deps.spoolerMonitor.cancelPrintJob(record.windowsQueueName, record.spoolerJobId);
        deps.jobQueue.removeJob(jobId);
        return { status: "completed", result: { windowsQueueName: record.windowsQueueName, spoolerJobId: record.spoolerJobId } };
      } catch (err) {
        logger.error("CANCEL_PRINT_JOB failed", { jobId, error: err instanceof Error ? err.message : String(err) });
        return { status: "failed", result: { reason: err instanceof Error ? err.message : String(err) } };
      }
    }

    case "RESTART_PRINT_QUEUE": {
      const printerProfileId = envelope.payload?.printerProfileId;
      const knownQueue =
        typeof printerProfileId === "string" ? deps.jobQueue.getQueueForProfile(printerProfileId) : undefined;
      logger.warn(
        "RESTART_PRINT_QUEUE received - Windows has no independent per-queue restart primitive, " +
          "so this restarts the whole Print Spooler service (affects every queue on this machine)",
        { printerProfileId, bestEffortQueueNameHint: knownQueue },
      );
      try {
        await deps.printerManager.restartSpooler();
        const queues = await deps.printerManager.discoverQueues();
        await deps.refreshHeartbeatNow();
        return { status: "completed", result: { queueCount: queues.length } };
      } catch (err) {
        logger.error("RESTART_PRINT_QUEUE failed", { error: err instanceof Error ? err.message : String(err) });
        return { status: "failed", result: { reason: err instanceof Error ? err.message : String(err) } };
      }
    }

    case "RESTART_AGENT_SERVICE": {
      logger.warn(
        "RESTART_AGENT_SERVICE received - acking and exiting the process shortly; " +
          "this requires the Windows Service's Recovery options to be configured to restart on failure (see README)",
      );
      deps.scheduleServiceRestart();
      return { status: "completed" };
    }

    case "CLEAR_AGENT_TEMP_FILES": {
      // Only ever deletes files under this agent's own configured local
      // storage path (downloads + tmp subdirectories) - never anything else,
      // and never a path derived from the command payload (this command
      // takes no path input at all).
      const downloadsDir = path.join(deps.localStoragePath, "downloads");
      const tmpDir = path.join(deps.localStoragePath, "tmp");
      const removed = clearFilesUnder(downloadsDir, logger) + clearFilesUnder(tmpDir, logger);
      logger.info("CLEAR_AGENT_TEMP_FILES completed", { removed, downloadsDir, tmpDir });
      return { status: "completed", result: { filesRemoved: removed } };
    }

    case "CHECK_FOR_UPDATE": {
      // Takes no payload at all (RemoteCommandPayload.CHECK_FOR_UPDATE is
      // Record<string, never>) and this branch reads none: the update
      // sequence self-update.ts runs is entirely hardcoded, in the Agent's
      // own checkout directory, with no value from the cloud reaching a
      // process invocation. See that module's header.
      const update = await deps.runSelfUpdate();

      // Every outcome - including "can't self-update at all" - acks as
      // `completed` with a specific reason, because the command DID run to a
      // definite conclusion; `failed` is reserved for the handler itself
      // going wrong. The console renders `message` verbatim, so an admin who
      // can't self-update is told exactly what to do instead of seeing a
      // button that appears to do nothing.
      if (update.updated) {
        // Same controlled-exit path RESTART_AGENT_SERVICE uses: the ack is
        // sent by the caller (orchestrator.ts pollCommands) before the exit
        // actually happens, so the result above is never lost to the restart.
        deps.scheduleServiceRestart();
      }
      return {
        status: "completed",
        result: { updated: update.updated, reason: update.reason, message: update.message },
      };
    }
  }
}
