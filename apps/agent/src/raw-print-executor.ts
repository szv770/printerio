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

import net from "node:net";
import { buildRawJob, UstatusFeedback, type PrinterAttention, type RawTarget } from "@printio/shared";

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
  /** Every expected sheet was reported finished. */
  | { outcome: "confirmed"; sheets: number; expected: number }
  /** The printer went quiet, closed, or reset without reporting every sheet and without an attention message: counts as sent, as before. */
  | { outcome: "unconfirmed"; reason: "stalled" | "closed" | "cap" | "error"; sheets: number; expected: number }
  /** The printer's latest device message was outside the normal 10xxx range when we gave up waiting: it needs a person. */
  | { outcome: "attention"; sheets: number; expected: number; code?: number; text: string };

export interface RawListen {
  /** Sheets the printer should report (expectedRawSheets). Must be a positive integer. */
  expectedSheets: number;
  /** No finished sheet for this long (and no attention showing) = give up and fall back to "sent". Default 90 s. */
  stallMs?: number;
  /** Overall cap after the data is flushed. Default listenCapMs(expectedSheets). */
  capMs?: number;
  /** After end(), how long until destroy(). Default 2 s. */
  destroyAfterMs?: number;
  /** Called when a message changes the sheet count or the attention state. */
  onUpdate?: (u: { sheets: number; expected: number; attention: PrinterAttention | null }) => void;
}

/** 60 s plus 6 s per sheet, never more than 30 minutes. */
export function listenCapMs(expectedSheets: number): number {
  return Math.min(30 * 60_000, 60_000 + 6_000 * Math.max(0, expectedSheets));
}

export const RAW_FEEDBACK_STALL_MS = 90_000;
export const RAW_FEEDBACK_DESTROY_AFTER_MS = 2_000;

/**
 * Like sendRawBytes, but with printer feedback: the data is written WITHOUT half-closing (a FIN right after the data
 * makes the Kyocera close at once and say nothing), and once it is flushed this resolves with `outcome`, a promise that
 * settles (never rejects) with a PrinterVerdict. Everything that goes wrong AFTER the flush (silence, reset, garbage,
 * attention) only ever yields a verdict: the bytes are at the printer, so nothing here may fail the send or send again.
 * Failures BEFORE the flush reject exactly like sendRawBytes. Our side is always closed with end() and then destroy().
 */
export function sendRawBytesListening(
  host: string,
  port: number,
  bytes: Uint8Array,
  timeouts: RawTimeouts,
  listen: RawListen,
): Promise<{ outcome: Promise<PrinterVerdict> }> {
  const connectMs = timeouts.connectTimeoutMs ?? RAW_CONNECT_TIMEOUT_MS;
  const writeMs = timeouts.writeTimeoutMs ?? RAW_WRITE_TIMEOUT_MS;
  const stallMs = listen.stallMs ?? RAW_FEEDBACK_STALL_MS;
  const capMs = listen.capMs ?? listenCapMs(listen.expectedSheets);
  const destroyAfterMs = listen.destroyAfterMs ?? RAW_FEEDBACK_DESTROY_AFTER_MS;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const fb = new UstatusFeedback(listen.expectedSheets);
    let connected = false;
    let sentPhaseOver = false; // resolved or rejected
    let flushed = false;
    let concluded = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    let capTimer: NodeJS.Timeout | undefined;
    let destroyTimer: NodeJS.Timeout | undefined;
    let watch: NodeJS.Timeout | undefined;
    let concludeOutcome!: (v: PrinterVerdict) => void;
    const outcome = new Promise<PrinterVerdict>((r) => {
      concludeOutcome = r;
    });
    const base = () => ({ sheets: fb.sheets, expected: fb.expectedSheets });

    const clearTimers = () => {
      for (const t of [connectTimer, stallTimer, capTimer, watch]) if (t) clearTimeout(t);
      if (watch) clearInterval(watch);
    };

    /** end() now, destroy() shortly after: never leave the printer's connection hanging on our side. */
    const closeOurSide = () => {
      try {
        socket.end();
      } catch {
        /* already closed */
      }
      if (socket.destroyed) return;
      destroyTimer = setTimeout(() => socket.destroy(), destroyAfterMs);
      socket.once("close", () => destroyTimer && clearTimeout(destroyTimer));
    };

    const conclude = (v: PrinterVerdict) => {
      if (concluded) return;
      concluded = true;
      clearTimers();
      closeOurSide();
      concludeOutcome(v);
    };
    const giveUp = (reason: "stalled" | "closed" | "cap" | "error") =>
      conclude(fb.attention ? { outcome: "attention", ...base(), ...(fb.attention.code !== undefined ? { code: fb.attention.code } : {}), text: fb.attention.text } : { outcome: "unconfirmed", reason, ...base() });

    const fail = (err: RawSendError) => {
      if (sentPhaseOver) return;
      sentPhaseOver = true;
      concluded = true;
      clearTimers();
      if (err.failure.bytesWritten === undefined && connected) err.failure.bytesWritten = socket.bytesWritten;
      socket.destroy();
      reject(err);
      concludeOutcome({ outcome: "unconfirmed", reason: "error", ...base() });
    };

    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      // While attention is showing the job keeps waiting (until the overall cap); a stall only ends a quiet, healthy job.
      stallTimer = setTimeout(() => {
        if (!fb.attention) giveUp("stalled");
      }, stallMs);
    };

    const sent = () => {
      if (sentPhaseOver) return;
      sentPhaseOver = true;
      flushed = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (watch) clearInterval(watch);
      resolve({ outcome });
      if (concluded) return;
      armStall();
      capTimer = setTimeout(() => giveUp("cap"), Math.max(1, capMs));
    };

    connectTimer = setTimeout(
      () => fail(new RawSendError(`raw print connect to ${host}:${port} timed out after ${connectMs}ms`, { kind: "connect_timeout" })),
      connectMs,
    );

    socket.on("data", (d: Buffer) => {
      if (concluded) return; // data that arrives before our flush callback still counts (a fast printer)
      const beforeSheets = fb.sheets;
      const beforeAttention = fb.attention?.text;
      let reports;
      try {
        reports = fb.push(d.toString("latin1"));
      } catch {
        return; // the parser never throws; garbage is ignored
      }
      const changed = fb.sheets !== beforeSheets || fb.attention?.text !== beforeAttention;
      if (changed) {
        try {
          listen.onUpdate?.({ ...base(), attention: fb.attention });
        } catch {
          /* a progress callback must never disturb the job */
        }
      }
      if (fb.complete) {
        conclude({ outcome: "confirmed", ...base() });
        return;
      }
      // Only a finished sheet (or attention appearing/clearing) shows the job is moving; TIMED device repeats do not.
      if (flushed && (reports.some((r) => r.kind === "page") || fb.attention?.text !== beforeAttention)) armStall();
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (!sentPhaseOver) {
        fail(new RawSendError(`raw print connection to ${host}:${port} failed: ${e.message}`, { kind: classifySocketError(e.code, connected), code: e.code }));
      } else giveUp("error");
    });
    socket.on("close", (hadError) => {
      if (!sentPhaseOver) {
        // The printer closed before our flush callback: fine only if every byte had already left this machine.
        if (hadError || socket.bytesWritten < bytes.length) {
          fail(new RawSendError(`raw print connection to ${host}:${port} closed with an error`, { kind: classifySocketError(undefined, connected) }));
          return;
        }
        sent();
      }
      giveUp("closed");
    });

    socket.connect(port, host, () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      const startedAt = Date.now();
      let lastPending = bytes.byteLength;
      let lastProgressAt = Date.now();
      watch = setInterval(
        () => {
          if (sentPhaseOver) return;
          const pending = socket.writableLength;
          if (pending < lastPending) {
            lastPending = pending;
            lastProgressAt = Date.now();
          }
          const stalled = Date.now() - lastProgressAt >= writeMs;
          const tooLong = Date.now() - startedAt >= RAW_MAX_SEND_MS;
          if (stalled || tooLong) {
            fail(new RawSendError(`raw print write to ${host}:${port} timed out after ${tooLong ? RAW_MAX_SEND_MS : writeMs}ms${stalled ? " without the printer taking any more data" : ""}`, { kind: "write_timeout", flushed: false }));
          }
        },
        Math.max(50, Math.min(1000, Math.floor(writeMs / 4))),
      );
      // Chunked like sendRawBytes; NO end(): the connection stays open so the printer can answer. The last callback = flushed.
      for (let off = 0; off < bytes.byteLength; off += WRITE_CHUNK_BYTES) {
        const last = off + WRITE_CHUNK_BYTES >= bytes.byteLength;
        socket.write(Buffer.from(bytes.buffer, bytes.byteOffset + off, Math.min(WRITE_CHUNK_BYTES, bytes.byteLength - off)), (err) => {
          if (!err && last) sent();
        });
      }
    });
  });
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
  /** Printer feedback (off when absent): ask the printer for USTATUS messages and listen on the open connection (see sendRawBytesListening). */
  feedback?: RawListen;
}): Promise<RawPrintResult> {
  const { raw, request, pdf, timeouts, feedback } = args;
  let job: ReturnType<typeof buildRawJob>;
  try {
    job = buildRawJob(
      {
        copies: request.copies,
        colorMode: request.colorMode,
        duplex: request.duplex,
        jobName: raw.jobName,
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
      const { outcome } = await sendRawBytesListening(raw.host, raw.port, job.bytes, timeouts ?? {}, feedback);
      return { ok: true, bytesSent: job.bytes.length, printerOutcome: outcome };
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
