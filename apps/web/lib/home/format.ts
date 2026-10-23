/**
 * Small, pure text helpers shared by the admin and teacher home pages
 * (and their dev preview). Everything takes `now` so it is testable and so the
 * server render and the sample-data preview agree.
 */

/** A print server (agent) that has not reported in for longer than this is shown as offline. */
export const HEARTBEAT_STALE_MS = 2 * 60_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ageMs(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now.getTime() - t);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or "never" when there is no valid date. */
export function timeAgo(iso: string | null | undefined, now: Date): string {
  const age = ageMs(iso, now);
  if (age === null) return "never";
  if (age < MIN) return "just now";
  if (age < HOUR) return `${Math.floor(age / MIN)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  const days = Math.floor(age / DAY);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "The oldest has waited 40 minutes." Empty string when there is nothing waiting. */
export function oldestWaitedText(oldestIso: string | null | undefined, now: Date): string {
  const age = ageMs(oldestIso, now);
  if (age === null) return "";
  if (age < MIN) return "The oldest just arrived.";
  if (age < HOUR) return `The oldest has waited ${plural(Math.floor(age / MIN), "minute", "minutes")}.`;
  if (age < DAY) return `The oldest has waited ${plural(Math.floor(age / HOUR), "hour", "hours")}.`;
  return `The oldest has waited ${plural(Math.floor(age / DAY), "day", "days")}.`;
}

/** True when the last report is missing, invalid or older than the stale threshold. */
export function isStale(lastSeenIso: string | null | undefined, now: Date, thresholdMs = HEARTBEAT_STALE_MS): boolean {
  const age = ageMs(lastSeenIso, now);
  if (age === null) return true;
  return age > thresholdMs;
}

/** "12 pages · 28 copies", "12 pages", "1 page", or "" when the size is unknown. */
export function jobSizeText(pages: number, copies: number): string {
  const parts: string[] = [];
  if (pages > 0) parts.push(plural(pages, "page", "pages"));
  if (pages > 0 && copies > 1) parts.push(plural(copies, "copy", "copies"));
  return parts.join(" · ");
}
