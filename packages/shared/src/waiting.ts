/**
 * "Waiting for the printer": a job the printer could not take RIGHT NOW (off, offline, unreachable, busy, or the
 * cause is unknown) is not a failed job. The raw port accepts data into the printer's buffer and prints when it is
 * ready, so the Agent releases the job back to the queue (claimed -> approved, an existing legal transition) and
 * it is tried again later. Only after the job has been unprintable for a long window does it become `failed`.
 *
 * WHERE THE STATE LIVES (no migration): `print_jobs.error_message` carries a stable marker while the job is
 * `approved` (or briefly `claimed` while it is being retried):
 *
 *     [printio:waiting v1 since=<ISO time> tries=<n> kind=<unavailable|unknown>] <plain sentence>
 *
 *  - `since` is when the job FIRST could not be sent (never reset by later retries, so it survives Agent restarts),
 *  - `tries` counts releases (drives the backoff), `kind` says whether we know the printer is unreachable.
 * The next-attempt time is `print_jobs.lease_expires_at` (in the future), which the existing claimable/claim
 * filter (`lease_expires_at is null or < now`) already uses to hide the job until then.
 * `attempt_count` is NOT touched and the quota reservation is NOT released: waiting is not a failed attempt.
 * When the window runs out the job becomes `failed` with a `[printio:gave-up]` message (plain words, Try again).
 *
 * Everything here is pure (no clock, no I/O) so the web, the Agent and the tests share one definition.
 */

export type WaitingKind = "unavailable" | "unknown";

export const WAITING_UNAVAILABLE_TEXT =
  "The printer is not available right now (off, offline or network). It will print when it is back.";
export const WAITING_UNKNOWN_TEXT = "Waiting for the printer - status unknown";

/** Backoff between attempts, by how many times the job has been released: 30 s, 1 m, 2 m, then 5 m for ever. */
export const WAITING_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];
/** How long a job may stay unprintable before it is failed (with Try again). Overridable by the web env. */
export const DEFAULT_WAITING_WINDOW_MS = 2 * 60 * 60 * 1000;

export function waitingBackoffMs(tries: number): number {
  const n = Number.isFinite(tries) ? Math.floor(tries) : 1;
  const i = Math.min(Math.max(n, 1), WAITING_BACKOFF_MS.length) - 1;
  return WAITING_BACKOFF_MS[i] as number;
}

const MARKER_PREFIX = "[printio:waiting";
const GAVE_UP_PREFIX = "[printio:gave-up]";

export interface WaitingInfo {
  /** Epoch ms of the first time the job could not be sent. */
  since: number;
  tries: number;
  kind: WaitingKind;
  /** The plain sentence to show. */
  text: string;
}

const textFor = (kind: WaitingKind): string => (kind === "unavailable" ? WAITING_UNAVAILABLE_TEXT : WAITING_UNKNOWN_TEXT);

export function formatWaitingMarker(input: { since: number; tries: number; kind: WaitingKind }): string {
  return `${MARKER_PREFIX} v1 since=${new Date(input.since).toISOString()} tries=${input.tries} kind=${input.kind}] ${textFor(input.kind)}`;
}

/** Tolerant: returns null for anything that is not a waiting marker; broken fields fall back to safe defaults. */
export function parseWaitingMarker(message: string | null | undefined): WaitingInfo | null {
  if (typeof message !== "string") return null;
  const m = /^\[printio:waiting\b([^\]]*)\]/.exec(message.trim());
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const part of (m[1] ?? "").split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const sinceRaw = Date.parse(fields.get("since") ?? "");
  const triesRaw = Number.parseInt(fields.get("tries") ?? "", 10);
  const kind: WaitingKind = fields.get("kind") === "unavailable" ? "unavailable" : "unknown";
  return {
    since: Number.isFinite(sinceRaw) ? sinceRaw : 0,
    tries: Number.isFinite(triesRaw) && triesRaw >= 1 ? triesRaw : 1,
    kind,
    text: textFor(kind),
  };
}

function describeWindow(windowMs: number): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The message stored on a job that waited the whole window. Marker first so display code can recognise it. */
export function gaveUpMessage(windowMs: number): string {
  return `${GAVE_UP_PREFIX} The printer was not available for ${describeWindow(windowMs)}, so Printio stopped trying. Check that the printer is on and connected, then press Try again.`;
}

/** The plain sentence of a gave-up message, or null when the text is something else. */
export function parseGaveUp(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  const t = message.trim();
  if (!t.startsWith(GAVE_UP_PREFIX)) return null;
  return t.slice(GAVE_UP_PREFIX.length).trim() || null;
}

export type ReleasePlan =
  | { action: "wait"; message: string; since: number; tries: number; retryAt: number; kind: WaitingKind }
  | { action: "fail"; message: string };

/**
 * Decides what the server does with a job the Agent could not send: wait (with the new marker and the time of the
 * next attempt) or, once `windowMs` has passed since the first miss, fail. `previous` is the job's current
 * error_message (a marker from earlier releases, or anything else, which is ignored).
 */
export function planRelease(input: { previous: string | null | undefined; now: number; windowMs: number; kind: WaitingKind }): ReleasePlan {
  const windowMs = Number.isFinite(input.windowMs) && input.windowMs > 0 ? input.windowMs : DEFAULT_WAITING_WINDOW_MS;
  const prev = parseWaitingMarker(input.previous);
  // since=0 means a marker without a readable time: restart the clock rather than fail instantly.
  const since = prev && prev.since > 0 ? prev.since : input.now;
  if (input.now - since >= windowMs) return { action: "fail", message: gaveUpMessage(windowMs) };
  const tries = (prev?.tries ?? 0) + 1;
  return {
    action: "wait",
    message: formatWaitingMarker({ since, tries, kind: input.kind }),
    since,
    tries,
    retryAt: input.now + waitingBackoffMs(tries),
    kind: input.kind,
  };
}
