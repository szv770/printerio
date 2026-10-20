import type { RawTarget } from "@printio/shared";

export type OutputMode = "queue" | "raw";
export type StaplePosition = "top-left" | "top-right";

const LABEL_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/** IPv4 dotted quad (each octet 0-255) or a plain hostname (letters, digits, hyphens, dots). */
export function isValidRawHost(host: string): boolean {
  if (!host || host.length > 253 || host !== host.trim()) return false;
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".");
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }
  return host.split(".").every((l) => LABEL_RE.test(l));
}

export function parseRawPort(value: string | null | undefined): { ok: true; port: number } | { ok: false; error: string } {
  const v = (value ?? "").trim();
  if (!v) return { ok: true, port: 9100 };
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
    return { ok: false, error: "Port must be a whole number from 1 to 65535 (usually 9100)." };
  }
  return { ok: true, port: Number(v) };
}

export interface OutputTargetInput {
  outputMode?: string | null;
  windowsQueueName?: string | null;
  rawHost?: string | null;
  rawPort?: string | null;
  rawStaplePosition?: string | null;
}

export interface OutputTarget {
  outputMode: OutputMode;
  windowsQueueName: string | null;
  rawHost: string | null;
  rawPort: number;
  rawStaplePosition: StaplePosition;
}

/** Validates the printer-destination part of a profile form. Queue name is required only for queue mode, host only for raw mode. */
export function parseOutputTarget(input: OutputTargetInput): { ok: true; value: OutputTarget } | { ok: false; error: string } {
  const staple: StaplePosition = input.rawStaplePosition === "top-right" ? "top-right" : "top-left";
  if (input.outputMode === "raw") {
    const host = (input.rawHost ?? "").trim();
    if (!host) return { ok: false, error: "Enter the printer's IP address or hostname." };
    if (!isValidRawHost(host)) return { ok: false, error: "That isn't a valid IP address (like 192.168.1.50) or hostname." };
    const port = parseRawPort(input.rawPort);
    if (!port.ok) return port;
    return { ok: true, value: { outputMode: "raw", windowsQueueName: null, rawHost: host, rawPort: port.port, rawStaplePosition: staple } };
  }
  const queue = (input.windowsQueueName ?? "").trim();
  if (!queue) return { ok: false, error: "Enter the Windows queue name." };
  return { ok: true, value: { outputMode: "queue", windowsQueueName: queue, rawHost: null, rawPort: 9100, rawStaplePosition: "top-left" } };
}

/** A short label that is safe to embed in a PJL header line. */
export function safeJobName(title: string | null | undefined): string {
  const cleaned = (title ?? "").replace(/[^A-Za-z0-9 ._()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return cleaned || "Printio job";
}

interface RawProfileFields {
  output_mode: string;
  raw_host: string | null;
  raw_port: number;
  raw_staple_position: string;
  booklet_binding_side: string;
}

/** Maps a printer_profiles row to the Agent's `raw` target, or undefined for queue-mode profiles. */
export function rawTargetFromProfile(
  profile: RawProfileFields,
  opts: {
    jobTitle?: string | null;
    /** The job's own booklet binding side (print_jobs.booklet_binding_side); null/absent = the printer's default. */
    bindingSide?: "left" | "right" | null;
    /** The job's own staple corner (print_jobs.staple_position); null/absent = the printer's default. */
    staplePosition?: StaplePosition | null;
  },
): RawTarget | undefined {
  if (profile.output_mode !== "raw" || !profile.raw_host) return undefined;
  const side = opts.bindingSide ?? (profile.booklet_binding_side === "right" ? "right" : "left");
  return {
    host: profile.raw_host,
    port: profile.raw_port,
    staplePosition: opts.staplePosition ?? (profile.raw_staple_position === "top-right" ? "top-right" : "top-left"),
    bindingSide: side,
    jobName: safeJobName(opts.jobTitle),
  };
}
