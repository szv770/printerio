/**
 * Raw-port output path: when a print request carries `raw` (profile
 * output_mode='raw'), the job bypasses SumatraPDF and the Windows spooler.
 * The PJL header + PDF is built by @printio/shared's buildRawJob() and
 * written straight to a TCP socket (normally printer:9100).
 *
 * Success = every byte flushed to the printer (and the printer did not reset the connection). The Kyocera often keeps
 * the socket open until its own job finishes, which can take many minutes for a big booklet, so a close is NOT awaited
 * for long: after the flush we give it RAW_CLOSE_GRACE_MS to close or reset, then count the job as sent. There is no
 * spooler job to identify or monitor. Never retried here: any failure is
 * returned as { ok: false, failure } and the orchestrator decides
 * (retry-policy.ts) whether the job waits for the printer or fails.
 */

import { randomBytes } from "node:crypto";
import net from "node:net";
import { buildRawJob, parsePageCount, sanitizePjlText, uniquePjlJobName, UstatusFeedback, type PrinterAttention, type RawTarget } from "@printio/shared";
import { holdSending } from "./send-activity.js";

/**
 * Statuses reported after a successful raw send, in order. The cloud state
 * machine forbids printing -> completed directly, so a raw job passes through
 * submitted_to_spooler (here meaning "the printer accepted the bytes").
 */
export const RAW_SUCCESS_STATUSES = ["submitted_to_spooler", "completed"] as const;

/**
 * The chain reported after a clean raw send when the job was kept `claimed`
 * while it was sent (so it could still have been released back to the queue
 * if the printer had not been available). Every step is a legal transition.
 */
export const RAW_DEFERRED_STATUSES = ["downloading", "downloaded", "printing", ...RAW_SUCCESS_STATUSES] as const;

export const RAW_CONNECT_TIMEOUT_MS = 15_000;
export const RAW_WRITE_TIMEOUT_MS = 120_000;
/** After every byte is flushed: how long to wait for the printer to close (or reset) before counting the job as sent. */
export const RAW_CLOSE_GRACE_MS = 20_000;
/** Hard ceiling for one send, however slowly a busy printer takes the data. */
export const RAW_MAX_SEND_MS = 60 * 60_000;
const WRITE_CHUNK_BYTES = 256 * 1024;
/**
 * What went wrong, as data, so the orchestrator decides "wait for the
 * printer" vs "fail" without parsing message text (see retry-policy.ts).
 *  - connect_*: nothing was sent (printer off / unreachable / refusing).
 *  - write_*: the connection was open but the bytes did not all get through,
 *    or the printer never closed the connection cleanly.
 *  - invalid_job: the job could not even be built (permanent).
 */
export type RawFailureKind =
  | "invalid_job"
  | "connect_timeout"
  | "connect_refused"
  | "connect_unreachable"
  | "connect_error"
  | "write_timeout"
  | "write_error";

export interface RawFailure {
  kind: RawFailureKind;
  /** Node/OS error code (ECONNREFUSED, EHOSTUNREACH, ECONNRESET, ...) when there was one. */
  code?: string;
  /** Bytes that left this machine before it failed (write phase only). */
  bytesWritten?: number;
  /**
   * write_timeout only: every byte was handed to the network and the connection was half-closed (FIN sent), and
   * what never happened is the printer closing its side. The printer may well HAVE the whole job (a Kyocera that
   * keeps port 9100 open while it works on it), so re-sending it could print it twice: such a job is failed with an
   * honest message instead of being released (retry-policy.ts).
   */
  flushed?: boolean;
}

export class RawSendError extends Error {
  readonly failure: RawFailure;
  constructor(message: string, failure: RawFailure) {
    super(message);
    this.name = "RawSendError";
    this.failure = failure;
  }
}

const UNREACHABLE_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EHOSTDOWN", "ENETDOWN", "EAI_AGAIN"]);

/** Exported for tests: maps a socket error seen before/after the connection was established to a failure kind. */
export function classifySocketError(code: string | undefined, connected: boolean): RawFailureKind {
  if (!connected) {
    if (code === "ECONNREFUSED") return "connect_refused";
    if (code && UNREACHABLE_CODES.has(code)) return "connect_unreachable";
    return "connect_error";
  }
  return "write_error";
}

export interface RawTimeouts {
  connectTimeoutMs?: number;
  /** Fails the send when no byte has left this machine for this long (a stall), not when the whole job takes this long. */
  writeTimeoutMs?: number;
  closeGraceMs?: number;
}

/** Connect, write all bytes, flush, close. Rejects (with a RawSendError) on refusal, error or timeout. */
export function sendRawBytes(
  host: string,
  port: number,
  bytes: Uint8Array,
  timeouts: RawTimeouts = {},
): Promise<void> {
  const connectMs = timeouts.connectTimeoutMs ?? RAW_CONNECT_TIMEOUT_MS;
  const writeMs = timeouts.writeTimeoutMs ?? RAW_WRITE_TIMEOUT_MS;
  const graceMs = timeouts.closeGraceMs ?? RAW_CLOSE_GRACE_MS;

  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let connected = false;
    let flushed = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err?: RawSendError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        if (err.failure.bytesWritten === undefined && connected) err.failure.bytesWritten = socket.bytesWritten;
        socket.destroy();
        reject(err);
      } else {
        resolve();
      }
    };

    timer = setTimeout(
      () => finish(new RawSendError(`raw print connect to ${host}:${port} timed out after ${connectMs}ms`, { kind: "connect_timeout" })),
      connectMs,
    );

    socket.once("error", (e: NodeJS.ErrnoException) =>
      finish(
        new RawSendError(`raw print connection to ${host}:${port} failed: ${e.message}`, {
          kind: classifySocketError(e.code, connected),
          code: e.code,
        }),
      ),
    );
    socket.once("finish", () => {
      flushed = true;
    });
    socket.once("close", (hadError) => {
      if (!hadError) finish();
      else finish(new RawSendError(`raw print connection to ${host}:${port} closed with an error`, { kind: classifySocketError(undefined, connected) }));
    });

    socket.connect(port, host, () => {
      connected = true;
      if (timer) clearTimeout(timer);
      const startedAt = Date.now();
      let lastPending = bytes.byteLength;
      let lastProgressAt = Date.now();
      const watch = setInterval(
        () => {
          if (settled || flushed) return;
          const pending = socket.writableLength;
          if (pending < lastPending) {
            lastPending = pending;
            lastProgressAt = Date.now();
          }
          const stalled = Date.now() - lastProgressAt >= writeMs;
          const tooLong = Date.now() - startedAt >= RAW_MAX_SEND_MS;
          if (stalled || tooLong) {
            clearInterval(watch);
            finish(new RawSendError(`raw print write to ${host}:${port} timed out after ${tooLong ? RAW_MAX_SEND_MS : writeMs}ms${stalled ? " without the printer taking any more data" : ""}`, { kind: "write_timeout", flushed: false }));
          }
        },
        Math.max(50, Math.min(1000, Math.floor(writeMs / 4))),
      );
      socket.once("close", () => clearInterval(watch));
      socket.once("finish", () => {
        clearInterval(watch);
        // Everything is with the printer. Wait briefly for a close or a reset; if it just stays open, the job is sent.
        timer = setTimeout(() => finish(), graceMs);
      });
      // Written in chunks so progress (the queue draining) is visible while a busy printer takes the data slowly.
      for (let off = 0; off < bytes.byteLength; off += WRITE_CHUNK_BYTES) {
        socket.write(Buffer.from(bytes.buffer, bytes.byteOffset + off, Math.min(WRITE_CHUNK_BYTES, bytes.byteLength - off)));
      }
      socket.end();
    });
  });
}

/** What the printer said about one job when printer feedback is on (see pjl-ustatus.ts for the message formats). */
export type PrinterVerdict =
  /** Our job's JOB END reported at least the expected number of pages. */
  | { outcome: "confirmed"; pages: number; expected: number }
  /** Nothing conclusive within the cap: counts as sent, as before. */
  | { outcome: "unconfirmed"; reason: "stalled" | "closed" | "cap" | "error"; pages: number; expected: number }
  /** The printer needs a person: a device code outside the normal range at the cap, or our job ended with fewer pages than expected. */
  | { outcome: "attention"; pages: number; expected: number; code?: number; text: string };

export interface RawListen {
  /** Pages the printer should report (expectedRawPages). Must be a positive integer. */
  expectedPages: number;
  /** Short unique token appended to the PJL job name so the printer's JOB END can be matched to this job. Default: random. */
  jobToken?: string;
  /** Gap between polls (each poll is a fresh short connection). Default: feedbackPollDelayMs (a first wait that grows with the job, then every 10-20 s). */
  pollIntervalMs?: number;
  /** How long each poll reads the printer's reply before closing. Default 1.5 s. */
  readMs?: number;
  /** Overall cap after the data is sent. Default listenCapMs(expectedPages). */
  capMs?: number;
  /** Read the printer's page counter (INFO PAGECOUNT) once BEFORE sending, so a later rise of at least expectedPages confirms the job. Off by default. */
  countBaseline?: boolean;
  /** Set by executeRawPrint from the baseline read: the counter value before the job (null = unknown, counter not used). */
  baselineCount?: number | null;
  /** Called when a message changes the attention state. */
  onUpdate?: (u: { pages: number; expected: number; attention: PrinterAttention | null }) => void;
}

/** 60 s plus 1.5 s per page (the engine prints about 85 pages a minute), never more than 30 minutes. */
export function listenCapMs(expectedPages: number): number {
  return Math.min(30 * 60_000, 60_000 + 1_500 * Math.max(0, expectedPages));
}

/**
 * How long a job may be waited on: the scaling cap, but never past its lease (the stale-lease sweep fails a job that is
 * still mid-flight when its lease ends, and a failed job can be re-sent). Keeps a 60 s margin; null = too little lease left,
 * so do not wait at all (the old behaviour).
 */
export function feedbackCapMs(expectedPages: number, leaseExpiresAt: string, nowMs: number): number | null {
  const leaseEnd = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(leaseEnd)) return null;
  const room = leaseEnd - nowMs - 60_000;
  if (room < 30_000) return null;
  return Math.min(listenCapMs(expectedPages), room);
}

/**
 * The wait before check number `index` (0 = the first). Each check is a new connection to the printer and may appear as an
 * entry in its own job log, so a job is checked a handful of times: the first check waits roughly as long as the job takes
 * to print (about 11 s plus 0.5 s per page, at most 60 s), then every 10 s, easing off to 20 s after 4 checks.
 */
export function feedbackPollDelayMs(index: number, expectedPages: number): number {
  if (index === 0) return Math.min(60_000, 10_000 + 500 * Math.max(0, expectedPages));
  return index < 5 ? 10_000 : 20_000;
}
export const RAW_FEEDBACK_READ_MS = 1_500;
const POLL_CONNECT_MS = 3_000;
const UEL = String.fromCharCode(27) + "%-12345X";
const INFO_STATUS_QUERY = `${UEL}@PJL\r\n@PJL INFO STATUS\r\n@PJL INFO PAGECOUNT\r\n${UEL}`;

/** One short connection: write the INFO STATUS and INFO PAGECOUNT questions, read for `readMs`, destroy. Resolves with what came back ("" on any error). */
function pollOnce(host: string, port: number, readMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const socket = new net.Socket();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(text);
    };
    // Connect failures (refused while the printer is busy or asleep) are normal: the caller just polls again.
    let timer = setTimeout(finish, POLL_CONNECT_MS);
    socket.on("data", (d: Buffer) => {
      text += d.toString("latin1");
    });
    socket.on("error", finish);
    socket.on("close", finish);
    socket.connect(port, host, () => {
      clearTimeout(timer);
      timer = setTimeout(finish, readMs);
      socket.write(INFO_STATUS_QUERY, "latin1");
    });
  });
}

/**
 * After the job was sent (data, then FIN, exactly like the normal path), asks the printer how it went. The Kyocera reports
 * only to a connection that opens AFTER the job ends: every `pollIntervalMs` a fresh short connection asks INFO STATUS and
 * the reply (queued USTATUS messages such as JOB END, plus the status itself) is fed to the parser, which keeps unfinished
 * messages between polls. Only the JOB END carrying OUR unique name counts; messages for other names are leftovers.
 * Never rejects, never sends anything but the status question.
 */
export async function pollPrinterVerdict(host: string, port: number, jobName: string, listen: RawListen): Promise<PrinterVerdict> {
  let checks = 0;
  const nextWait = () => listen.pollIntervalMs ?? feedbackPollDelayMs(checks++, listen.expectedPages);
  const readMs = listen.readMs ?? RAW_FEEDBACK_READ_MS;
  const capMs = Math.max(1, listen.capMs ?? listenCapMs(listen.expectedPages));
  const fb = new UstatusFeedback(listen.expectedPages, jobName);
  const baseline = typeof listen.baselineCount === "number" ? listen.baselineCount : null;
  let counterPages = 0; // how far the printer's page counter has risen since before the job (never negative)
  const base = () => ({ pages: Math.max(fb.pages, counterPages), expected: fb.expectedPages });
  const deadline = Date.now() + capMs;
  let lastAttention: string | undefined;
  try {
    for (;;) {
      const wait = Math.min(nextWait(), deadline - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (Date.now() >= deadline) break;
      const text = await pollOnce(host, port, Math.max(1, Math.min(readMs, deadline - Date.now() + 200)));
      if (text) fb.push(text);
      const counter = baseline === null ? null : parsePageCount(text);
      if (counter !== null && baseline !== null && counter >= baseline) {
        counterPages = counter - baseline;
        // The counter is the dependable signal (the job-end message is only pushed to a connection that happens to be open).
        // Someone else printing at the same time can inflate it, so this says "the printer's counter rose", nothing more.
        if (counterPages >= listen.expectedPages) return { outcome: "confirmed", ...base() };
      }
      if (fb.attention?.text !== lastAttention) {
        lastAttention = fb.attention?.text;
        try {
          listen.onUpdate?.({ ...base(), attention: fb.attention });
        } catch {
          /* a progress callback must never disturb the job */
        }
      }
      if (fb.complete) return { outcome: "confirmed", ...base() };
      if (fb.finishedShort) {
        return { outcome: "attention", ...base(), text: `The printer finished the job but reported only ${fb.pages} of ${fb.expectedPages} pages` };
      }
    }
  } catch {
    return { outcome: "unconfirmed", reason: "error", ...base() };
  }
  if (fb.attention) {
    return { outcome: "attention", ...base(), ...(fb.attention.code !== undefined ? { code: fb.attention.code } : {}), text: fb.attention.text };
  }
  return { outcome: "unconfirmed", reason: "cap", ...base() };
}

export interface RawPrintRequest {
  copies: number;
  colorMode: "bw" | "color";
  duplex: boolean;
  finishing: { staple: boolean; booklet: boolean; punch: boolean };
}

export type RawPrintResult =
  | {
      ok: true;
      bytesSent: number;
      /** Only with printer feedback: settles (never rejects) with what the printer reported about this job. */
      printerOutcome?: Promise<PrinterVerdict>;
    }
  | { ok: false; reason: string; failure: RawFailure };

export async function executeRawPrint(args: {
  raw: RawTarget;
  request: RawPrintRequest;
  pdf: Uint8Array;
  timeouts?: RawTimeouts;
  /** Printer feedback (off when absent): send exactly like the normal path, then poll the printer for our job's JOB END (see pollPrinterVerdict). */
  feedback?: RawListen;
}): Promise<RawPrintResult> {
  const { raw, request, pdf, timeouts, feedback } = args;
  // With feedback every raw job gets a UNIQUE PJL name (title + token) so the printer's JOB END can only ever be ours.
  const jobName = feedback ? uniquePjlJobName(raw.jobName, feedback.jobToken ?? randomBytes(4).toString("hex")) : raw.jobName;
  let job: ReturnType<typeof buildRawJob>;
  try {
    job = buildRawJob(
      {
        copies: request.copies,
        colorMode: request.colorMode,
        duplex: request.duplex,
        jobName: jobName,
        ...(raw.duplexEdge ? { duplexEdge: raw.duplexEdge } : {}),
        ...(raw.paper ? { paper: raw.paper } : {}),
        staple: request.finishing.staple ? raw.staplePosition : undefined,
        booklet: request.finishing.booklet,
        bindingSide: raw.bindingSide,
        ...(feedback ? { ustatus: true } : {}),
      },
      pdf,
    );
  } catch (err) {
    // buildRawJob throws only for a document carrying printer control codes (security review F1).
    return { ok: false, reason: err instanceof Error ? err.message : String(err), failure: { kind: "invalid_job" } };
  }
  if (!job.ok) return { ok: false, reason: job.reason, failure: { kind: "invalid_job" } };
  try {
    if (feedback) {
      // One short read of the page counter BEFORE the job, so the same counter read afterwards shows how many pages came out.
      const baselineCount = feedback.countBaseline
        ? parsePageCount(await pollOnce(raw.host, raw.port, feedback.readMs ?? RAW_FEEDBACK_READ_MS))
        : (feedback.baselineCount ?? null);
      await sendRawBytes(raw.host, raw.port, job.bytes, timeouts);
      // The agent's own status probe must stay off port 9100 until the verdict: it would swallow our JOB END message.
      const release = holdSending();
      const printerOutcome = pollPrinterVerdict(raw.host, raw.port, sanitizePjlText(jobName), { ...feedback, baselineCount })
        .catch((): PrinterVerdict => ({ outcome: "unconfirmed", reason: "error", pages: 0, expected: feedback.expectedPages }))
        .finally(release);
      return { ok: true, bytesSent: job.bytes.length, printerOutcome };
    }
    await sendRawBytes(raw.host, raw.port, job.bytes, timeouts);
    return { ok: true, bytesSent: job.bytes.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Anything that is not one of ours is an unclassified socket-level problem: waited on as "unknown".
    const failure: RawFailure = err instanceof RawSendError ? err.failure : { kind: "write_error" };
    return { ok: false, reason, failure };
  }
}
