"use server";

import { revalidatePath } from "next/cache";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { dailyFeedUrl, parseDailyFeed, type DailyDay } from "@/lib/library/daily/feed";
import { prepareImport } from "@/lib/library/daily/import";
import type { Json } from "@/lib/database.types";

/**
 * "Import from my browser" in the library's Daily study tab. Org admins only. Chabad.org shows automated visitors a Cloudflare check
 * that we never get past, so an admin opens the study page in their own browser, saves it ("Webpage, HTML only") and gives the
 * file(s) here. Each file must be the portion Chabad.org's own feed names for the chosen date; the text is then saved once for
 * everyone (see docs/daily-study.md).
 */

export interface ImportFileResult {
  name: string;
  ok: boolean;
  message: string;
}
export interface ImportDailyResult {
  ok: boolean;
  message: string;
  results: ImportFileResult[];
}

const MAX_FILES = 4;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FEED_BYTES = 200 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (message: string, results: ImportFileResult[] = []): ImportDailyResult => ({ ok: false, message, results });

/** Chabad.org's feed for one date: an ordinary request to a public feed, with a size and time limit. */
async function fetchFeed(date: string): Promise<DailyDay | null> {
  try {
    const res = await fetch(dailyFeedUrl(date), {
      headers: { "user-agent": "Printio/1.0 (daily study list)", accept: "application/rss+xml, text/xml" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok || !/xml/i.test(res.headers.get("content-type") ?? "")) return null;
    const xml = await res.text();
    if (xml.length > MAX_FEED_BYTES) return null;
    const day = parseDailyFeed(xml);
    return day.date === date ? day : null;
  } catch {
    return null;
  }
}

export async function importDailyAction(formData: FormData): Promise<ImportDailyResult> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return fail("Your account is not part of an organization yet.");
  if (session.membership.role !== "org_admin") return fail("Only an admin can import the daily study.");

  const date = String(formData.get("date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return fail("Choose a date.");
  if (Math.abs(Date.parse(date) - Date.now()) > 400 * DAY_MS) return fail("That date is too far from today.");

  const files = formData.getAll("files").filter((f): f is File => typeof f !== "string");
  if (files.length === 0) return fail("Choose at least one saved page.");
  if (files.length > MAX_FILES) return fail(`Import up to ${MAX_FILES} pages at a time.`);

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `daily_import:user:${session.userId}`,
    p_max_count: 20,
    p_window_seconds: 10 * 60,
  });
  if (!limitError && allowed === false) return fail("That is a lot of importing at once. Wait a few minutes and try again.");

  const feed = await fetchFeed(date);
  if (!feed) return fail("Printio could not read Chabad.org's list for that day. Try again in a minute.");

  const results: ImportFileResult[] = [];
  for (const file of files) {
    const name = file.name.slice(0, 120);
    if (!/\.html?$/i.test(file.name)) {
      results.push({ name, ok: false, message: "Save the page as \"Webpage, HTML only\" (a .htm or .html file)." });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({ name, ok: false, message: "That file is too big to be a study page." });
      continue;
    }
    const prepared = prepareImport(await file.text(), feed);
    if (!prepared.ok) {
      results.push({ name, ok: false, message: prepared.message });
      continue;
    }
    const { error } = await db.from("library_daily_texts").upsert({ ...prepared.row, sections: prepared.row.sections as unknown as Json, fetched_at: new Date().toISOString(), added_by: session.userId }, { onConflict: "study,study_date" });
    results.push(error ? { name, ok: false, message: "Printio could not save that page. Try again." } : { name, ok: true, message: `Saved: ${prepared.row.portion}` });
  }

  const saved = results.filter((r) => r.ok).length;
  if (saved > 0) revalidatePath("/print/library");
  return { ok: saved > 0, message: saved === results.length ? `Saved ${saved} ${saved === 1 ? "page" : "pages"}.` : `Saved ${saved} of ${results.length}.`, results };
}
