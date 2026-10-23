import { DEFAULT_WAITING_WINDOW_MS } from "@printio/shared";

const MIN_MINUTES = 1;
const MAX_MINUTES = 7 * 24 * 60;

/**
 * How long a job may stay "waiting for the printer" before it is failed (with a Try again button).
 * Default 2 hours; override with PRINTIO_WAITING_WINDOW_MINUTES (1 minute .. 7 days). Anything unreadable falls
 * back to the default rather than failing jobs instantly. Read per call so a Vercel env change needs no rebuild
 * logic of ours.
 */
export function waitingWindowMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PRINTIO_WAITING_WINDOW_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_WAITING_WINDOW_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return DEFAULT_WAITING_WINDOW_MS;
  return Math.round(minutes * 60_000);
}
