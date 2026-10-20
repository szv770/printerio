/**
 * Raw-port output path: when a print request carries `raw` (profile
 * output_mode='raw'), the job bypasses SumatraPDF and the Windows spooler.
 * The PJL header + PDF is built by @printio/shared's buildRawJob() and
 * written straight to a TCP socket (normally printer:9100).
 *
 * Success = every byte flushed and the socket closed cleanly. There is no
 * spooler job to identify or monitor. Never retried here: any failure is
 * returned as { ok: false } and the orchestrator reports it once.
 */

import net from "node:net";
import { buildRawJob, type RawTarget } from "@printio/shared";

/**
 * Statuses reported after a successful raw send, in order. The cloud state
 * machine forbids printing -> completed directly, so a raw job passes through
 * submitted_to_spooler (here meaning "the printer accepted the bytes").
 */
export const RAW_SUCCESS_STATUSES = ["submitted_to_spooler", "completed"] as const;

export const RAW_CONNECT_TIMEOUT_MS = 15_000;
export const RAW_WRITE_TIMEOUT_MS = 120_000;

export interface RawTimeouts {
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

/** Connect, write all bytes, flush, close. Rejects on refusal, error or timeout. */
export function sendRawBytes(
  host: string,
  port: number,
  bytes: Uint8Array,
  timeouts: RawTimeouts = {},
): Promise<void> {
  const connectMs = timeouts.connectTimeoutMs ?? RAW_CONNECT_TIMEOUT_MS;
  const writeMs = timeouts.writeTimeoutMs ?? RAW_WRITE_TIMEOUT_MS;

  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve();
      }
    };

    timer = setTimeout(() => finish(new Error(`raw print connect to ${host}:${port} timed out after ${connectMs}ms`)), connectMs);

    socket.once("error", (e) => finish(new Error(`raw print connection to ${host}:${port} failed: ${e.message}`)));
    socket.once("close", (hadError) => {
      if (!hadError) finish();
      else finish(new Error(`raw print connection to ${host}:${port} closed with an error`));
    });

    socket.connect(port, host, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(`raw print write to ${host}:${port} timed out after ${writeMs}ms`)), writeMs);
      // end() flushes pending data then sends FIN; "close" then means done.
      socket.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
  });
}

export interface RawPrintRequest {
  copies: number;
  colorMode: "bw" | "color";
  duplex: boolean;
  finishing: { staple: boolean; booklet: boolean; punch: boolean };
}

export type RawPrintResult = { ok: true; bytesSent: number } | { ok: false; reason: string };

export async function executeRawPrint(args: {
  raw: RawTarget;
  request: RawPrintRequest;
  pdf: Uint8Array;
  timeouts?: RawTimeouts;
}): Promise<RawPrintResult> {
  const { raw, request, pdf, timeouts } = args;
  const job = buildRawJob(
    {
      copies: request.copies,
      colorMode: request.colorMode,
      duplex: request.duplex,
      jobName: raw.jobName,
      staple: request.finishing.staple ? raw.staplePosition : undefined,
      booklet: request.finishing.booklet,
      bindingSide: raw.bindingSide,
    },
    pdf,
  );
  if (!job.ok) return { ok: false, reason: job.reason };
  try {
    await sendRawBytes(raw.host, raw.port, job.bytes, timeouts);
    return { ok: true, bytesSent: job.bytes.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
