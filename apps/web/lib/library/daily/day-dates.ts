/** Date helpers for the daily-text endpoints. Days are plain ISO dates (YYYY-MM-DD); "today" is the website's UTC date. */

const DAY_MS = 86_400_000;

/** True for a real calendar date written 2026-11-02 (2026-02-30 is not one). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function todayIso(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole days from today to `iso` (negative = in the past). */
export function daysFromToday(iso: string, now: number = Date.now()): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso(now)}T00:00:00Z`)) / DAY_MS);
}

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
