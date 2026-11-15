import { z } from "zod";
import { apiError } from "@/lib/api-errors";
import { readJsonBody, requireLibraryFetcher } from "@/lib/library/server-jobs";
import { daysFromToday, isIsoDate } from "@/lib/library/daily/day-dates";
import { MAX_DAY_BYTES, shiurDaySchema } from "@/lib/library/daily/day-schema";
import { shiurUrl } from "@printio/shared/library/daily/source";
import type { Json } from "@/lib/database.types";

/** The date a day is posted for may be at most this many days from today (either side). */
export const MAX_DATE_DRIFT_DAYS = 10;

/** Only `date` and `day` are read. Anything else in the body (a url, a source, an author) is dropped unread. */
const bodySchema = z.object({ date: z.unknown(), day: z.unknown() });

/**
 * See docs/agent-api.md. A library-fetcher print server posts one day of daily study text it fetched from the source.
 * The website validates it, rebuilds the source address ITSELF from the date (`shiurUrl`; no address in the request is ever
 * read), and saves each study with INSERT ... ON CONFLICT DO NOTHING on (study, study_date): a study that is already saved is
 * never touched (first writer wins), whoever sent the second copy. `added_by` stays empty: nobody signed in wrote it.
 */
export async function POST(request: Request) {
  const guard = await requireLibraryFetcher(request);
  if (guard instanceof Response) return guard;
  const { db } = guard;

  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return apiError(400, "invalid_body", "The body must be { date, day }.");

  const { date } = body.data;
  if (!isIsoDate(date) || Math.abs(daysFromToday(date)) > MAX_DATE_DRIFT_DAYS) {
    return apiError(400, "invalid_date", `date must be a date like 2026-11-02, at most ${MAX_DATE_DRIFT_DAYS} days from today.`);
  }

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body.data.day) ?? "", "utf8");
  } catch {
    return apiError(400, "invalid_day", "The day is not JSON.");
  }
  if (bytes > MAX_DAY_BYTES) return apiError(413, "too_large", "The day is too large.");

  const day = shiurDaySchema.safeParse(body.data.day);
  if (!day.success) return apiError(400, "invalid_day", "The day is not a daily study page the library can read.");
  if (day.data.date !== date) return apiError(400, "date_mismatch", "The day's own date is not the date it was posted for.");

  const sourceUrl = shiurUrl(date);
  const fetchedAt = new Date().toISOString();
  const rows = day.data.studies.map((s) => ({
    study: s.study,
    study_date: date,
    portion: s.portion,
    sections: s.sections as unknown as Json,
    source_url: sourceUrl,
    fetched_at: fetchedAt,
    added_by: null,
  }));

  // ignoreDuplicates = ON CONFLICT DO NOTHING: only rows that did not exist come back.
  const { data: inserted, error } = await db.from("library_daily_texts").upsert(rows, { onConflict: "study,study_date", ignoreDuplicates: true }).select("study");
  if (error) return apiError(500, "internal_error", "Failed to save the day.");
  const added = inserted?.length ?? 0;
  return Response.json({ ok: true, inserted: added, existing: rows.length - added });
}
