/**
 * Safety net after an UNCONFIRMED raw job (incident 2026-11-15, docs/kyocera-raw-print.md): the Kyocera showed
 * "System error. Turn the main power switch off and on." after a job it never confirmed, and the next teachers'
 * jobs were sent straight into the dead printer and silently wasted.
 *
 * How it works, per physical printer (host:port):
 *  - When a raw job ends without the printer confirming its pages (verdict "unconfirmed" or "attention"), the printer is
 *    marked SUSPECT (`markSuspect`). A confirmed job clears the mark (`markHealthy`).
 *  - Before the NEXT raw job is sent to a suspect printer, `check` asks it ONE cheap question (the same `@PJL INFO STATUS`
 *    read the status monitor uses, printer-probe.ts). A printer that is not suspect costs nothing: no network call at all.
 *  - A healthy answer clears the mark and the job goes ahead. A printer that reports a problem or does not answer blocks
 *    the job: the orchestrator releases it back to the queue to wait (the existing "printer not available" path) and the
 *    next poll asks again, until the printer reads healthy.
 *
 * Judged healthy: it answered, is not offline, and its code is in the normal 10xxx range (10001 Ready, 10023 Processing)
 * or 35078 Sleeping (isAttentionCode). The System error code has never been seen, so ANY other code counts as a problem.
 * Silence counts as a problem too (one retry first), because that is exactly what a dead printer sounds like.
 *
 * Never blocks for good: the mark is dropped after SUSPECT_CAP_MS whatever the probe says (logged), and a probe that
 * cannot run at all (it throws) FAILS OPEN - a broken check must never turn a healthy printer into an outage.
 */

import { isAttentionCode, type PrinterProbeFacts } from "@printio/shared";
import type { Logger } from "./logger.js";
import { probePrinter } from "./printer-probe.js";

/** A suspect mark that nobody cleared is dropped after this long, so a bad probe can never block a printer for ever. */
export const SUSPECT_CAP_MS = 10 * 60_000;
/** Pause before the second try when the first one got no answer (a printer waking from sleep, a busy port). */
export const PROBE_RETRY_DELAY_MS = 1_000;

/**
 * The sentence the owner asked for, followed by the technical reason. It is logged and sent to the web app as the release
 * `detail` (job event metadata); the job's own text on the website is the web app's standard "waiting for the printer"
 * wording for an "unavailable" release.
 */
export const PRINTER_PROBLEM_SENTENCE =
  "The printer reported a problem and Printio is waiting for it to be fixed (turn the printer off and on at the main switch). Jobs will print when it is ready.";

export type ProbeJudgement = { healthy: true } | { healthy: false; why: string };

/** Pure: what a status read means for sending the next job. Exported for tests. */
export function judgeProbe(f: PrinterProbeFacts): ProbeJudgement {
  if (!f.answered) return { healthy: false, why: f.reachable ? "the printer accepted the connection but did not answer the status question" : "the printer could not be reached" };
  if (f.online === false) return { healthy: false, why: `the printer reports it is offline${f.display ? ` (${f.display})` : ""}` };
  if (isAttentionCode(f.code)) return { healthy: false, why: `the printer reports ${f.code}${f.display ? ` "${f.display}"` : ""}` };
  return { healthy: true };
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

export interface PrinterHealthGate {
  /** A raw job to this printer ended without the printer confirming it. */
  markSuspect(key: string): void;
  /** A job to this printer was confirmed: it is working. */
  markHealthy(key: string): void;
  /** Called before sending a raw job. Not suspect: allowed with no network call. Never throws. */
  check(key: string, target: { host: string; port: number }): Promise<GateDecision>;
  /** Whether the printer is currently marked suspect (tests). */
  isSuspect(key: string): boolean;
}

export interface PrinterHealthGateOptions {
  logger: Logger;
  now?: () => number;
  probe?: typeof probePrinter;
  capMs?: number;
  retryDelayMs?: number;
}

export function createPrinterHealthGate(opts: PrinterHealthGateOptions): PrinterHealthGate {
  const { logger } = opts;
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? probePrinter;
  const capMs = opts.capMs ?? SUSPECT_CAP_MS;
  const retryDelayMs = opts.retryDelayMs ?? PROBE_RETRY_DELAY_MS;
  /** printer key -> when it was marked, and whether the "blocked" line has been logged for this episode. */
  const suspect = new Map<string, { since: number; blocked: boolean }>();

  async function readStatus(target: { host: string; port: number }): Promise<PrinterProbeFacts> {
    const first = await probe(target);
    if (first.answered) return first;
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return probe(target);
  }

  return {
    markSuspect(key) {
      if (!suspect.has(key)) suspect.set(key, { since: now(), blocked: false });
    },
    markHealthy(key) {
      suspect.delete(key);
    },
    isSuspect: (key) => suspect.has(key),
    async check(key, target) {
      const mark = suspect.get(key);
      if (!mark) return { allow: true };
      if (now() - mark.since >= capMs) {
        suspect.delete(key);
        logger.warn("printer was held after an unconfirmed job for too long - sending jobs to it again", { printer: key, heldMs: now() - mark.since });
        return { allow: true };
      }
      let facts: PrinterProbeFacts;
      try {
        facts = await readStatus(target);
      } catch (err) {
        suspect.delete(key);
        logger.warn("could not check the printer's status after an unconfirmed job - sending anyway", { printer: key, error: err instanceof Error ? err.message : String(err) });
        return { allow: true };
      }
      const verdict = judgeProbe(facts);
      if (verdict.healthy) {
        suspect.delete(key);
        if (mark.blocked) logger.info("printer reads healthy again - raw printing resumes", { printer: key, code: facts.code, display: facts.display });
        else logger.debug("printer reads healthy after an unconfirmed job", { printer: key, code: facts.code, display: facts.display });
        return { allow: true };
      }
      if (!mark.blocked) {
        mark.blocked = true;
        logger.warn("printer looks unhealthy after an unconfirmed job - holding raw jobs for it until it reads ready", {
          printer: key,
          why: verdict.why,
          code: facts.code,
          display: facts.display,
        });
      } else {
        logger.debug("printer still not ready - job stays queued", { printer: key, why: verdict.why });
      }
      return { allow: false, reason: `${PRINTER_PROBLEM_SENTENCE} [${verdict.why}]` };
    },
  };
}
