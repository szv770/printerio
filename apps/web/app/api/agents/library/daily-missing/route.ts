import { apiError } from "@/lib/api-errors";
import { requireLibraryFetcher } from "@/lib/library/server-jobs";
import { addDays, daysFromToday, isIsoDate } from "@/lib/library/daily/day-dates";

/** Most days one question may cover (the print server asks for a week; one spare). */
export const MAX_DAYS = 8;
/** The start date may be at most this many days from today (either side): the print server's clock is its own. */
export const MAX_START_DRIFT_DAYS = 2;

/**
 * See docs/agent-api.md. A library-fetcher print server asks which of the next `days` days (from `from`) have NO saved daily
 * study text yet, so it only fetches those. A day counts as missing when `library_daily_texts` holds no row at all for that
 * date; one saved study is enough to call it present (the simple rule: the website never fetches the rest of a day live
 * when the switch is on, and a day is saved whole by the one writer). Read-only.
 */
export async function GET(request: Request) {
  const guard = await requireLibraryFetcher(request);
  if (guard instanceof Response) return guard;
  const { db } = guard;

  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  if (!isIsoDate(from) || Math.abs(daysFromToday(from)) > MAX_START_DRIFT_DAYS) {
    return apiError(400, "invalid_date", `from must be a date like 2026-11-02, at most ${MAX_START_DRIFT_DAYS} days from today.`);
  }
  const rawDays = params.get("days");
  const days = rawDays !== null && /^\d{1,2}$/.test(rawDays) ? Number(rawDays) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return apiError(400, "invalid_days", `days must be a whole number from 1 to ${MAX_DAYS}.`);

  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const { data, error } = await db.from("library_daily_texts").select("study_date").gte("study_date", dates[0]!).lte("study_date", dates[dates.length - 1]!);
  if (error) return apiError(500, "internal_error", "Failed to look up the saved days.");

  const present = new Set((data ?? []).map((r) => r.study_date));
  return Response.json({ missing: dates.filter((d) => !present.has(d)) });
}
