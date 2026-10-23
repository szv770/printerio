/**
 * Wait-or-fail decisions for the raw-port path. Owner decision (2026-10-23): a jam, a toner change, paper out, a
 * busy, switched-off or unreachable printer must NOT fail a job. The printer's raw port accepts data into its
 * buffer and prints when it is ready, so when the Agent cannot hand the job over - or cannot tell why - the job is
 * RELEASED back to the queue (the web app applies the exponential backoff and the long give-up window, see
 * apps/web/app/api/agents/jobs/[jobId]/release and packages/shared/src/waiting.ts) instead of being failed.
 *
 *   cause                                      -> decision
 *   connect timed out / refused / unreachable  -> release "unavailable"  (printer off, offline, network)
 *   write stalled (buffer full, jam)           -> release "unavailable"
 *   ...but every byte was already sent and only
 *   the printer's close is missing             -> FAIL (it may have the whole job; a re-send could print twice)
 *   other socket error / reset mid-write       -> release "unknown"
 *   fetching the document failed (network/5xx) -> release "unknown"
 *   job cannot be built, document missing/bad  -> FAIL now with its message (permanent)
 *   anything we have never seen                -> release "unknown"
 *
 * NOT detectable here: a printer that accepts the bytes and then rejects the PDF (the raw port gives no
 * feedback), so that case is not "failed" either.
 */
import type { RawFailure } from "./raw-print-executor.js";

export type WaitKind = "unavailable" | "unknown";
export type Decision = { action: "release"; kind: WaitKind } | { action: "fail" };

export function decideRawFailure(failure: RawFailure): Decision {
  switch (failure.kind) {
    case "invalid_job":
      return { action: "fail" };
    case "write_timeout":
      // Everything was sent and only the printer's close is missing: it may already have the job, and sending it
      // again could print it twice. Fail with an honest message (Try again is one tap) rather than risk paper.
      if (failure.flushed) return { action: "fail" };
      return { action: "release", kind: "unavailable" };
    case "connect_timeout":
    case "connect_refused":
    case "connect_unreachable":
      return { action: "release", kind: "unavailable" };
    case "connect_error":
    case "write_error":
    default:
      return { action: "release", kind: "unknown" };
  }
}

export function decideDownloadFailure(failure: { kind: "transient" | "permanent" }): Decision {
  return failure.kind === "transient" ? { action: "release", kind: "unknown" } : { action: "fail" };
}

/**
 * After a job is released as "unavailable", the Agent leaves that printer profile's other jobs alone for this long
 * (they stay queued and are not even claimed) and then probes with one job - the oldest - again. Equal to the first
 * backoff step of the web app. Without it, one printer being off with 50 queued jobs would mean 50 sequential
 * 15-second connect timeouts per poll, starving heartbeats and remote commands.
 */
export const PROFILE_COOLDOWN_MS = 30_000;
