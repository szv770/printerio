"use server";

import { revalidatePath } from "next/cache";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { fetchDailyFeed } from "@/lib/library/daily/feed-fetch";
import { fetchShiurDay } from "@/lib/library/daily/source-fetch";
import { prepareImport } from "@/lib/library/daily/import";
import type { Json } from "@/lib/database.types";
import { canUseLinks } from "@/lib/sources/access";
import { buildFilledPdf, type Language } from "@/lib/library/daily/fill";
import type { StudySection } from "@/lib/library/daily/page";
import { DAILY_CREDIT, isOfferedStudy, longDate, OFFERED_STUDIES, STUDY_LABELS, type OfferedStudy } from "@/lib/library/daily/studies";

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
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (message: string, results: ImportFileResult[] = []): ImportDailyResult => ({ ok: false, message, results });

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

  const feed = await fetchDailyFeed(date);
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

type Failure = { ok: false; message: string };

/** Same people as the rest of the library: admins, and anyone an admin switched early tools on for. */
async function libraryGate(): Promise<{ userId: string } | Failure> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, message: "Your account is not part of an organization yet." };
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) {
    return { ok: false, message: "The library is being tested with admins first. Ask an admin to switch early tools on for you." };
  }
  return { userId: session.userId };
}

const validDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && Math.abs(Date.parse(d) - Date.now()) <= 400 * DAY_MS;

export interface DailyDayItem {
  study: OfferedStudy;
  label: string;
  portion: string;
}

interface DayRow {
  study: string;
  portion: string;
  sections: StudySection[];
}

/**
 * The day's saved text. When nothing is saved for the date yet, Printio asks the source once (as a person opening the page and
 * making a booklet would), saves every study on it for everyone, and uses that.
 */
async function ensureDay(db: ReturnType<typeof createServiceRoleClient>, date: string, userId: string): Promise<{ ok: true; rows: DayRow[] } | Failure> {
  const { data } = await db.from("library_daily_texts").select("study, portion, sections").eq("study_date", date);
  const saved = (data ?? []) as unknown as DayRow[];
  if (saved.length > 0) return { ok: true, rows: saved };

  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `daily_fetch:user:${userId}`,
    p_max_count: 12,
    p_window_seconds: 10 * 60,
  });
  if (!limitError && allowed === false) return { ok: false, message: "That is a lot of days at once. Wait a few minutes and try again." };

  const got = await fetchShiurDay(date);
  if (!got.ok) {
    return {
      ok: false,
      message: got.reason === "different"
        ? "The daily study source looks different today, so Printio could not read it. Tell the Printio owner."
        : "Printio could not get the daily study for that day from its source right now. Try again in a minute.",
    };
  }
  const now = new Date().toISOString();
  const rows = got.day.studies.map((s) => ({ study: s.study, study_date: date, portion: s.portion, sections: s.sections as unknown as Json, source_url: got.url, fetched_at: now, added_by: userId }));
  const { error } = await db.from("library_daily_texts").upsert(rows, { onConflict: "study,study_date" });
  if (error) return { ok: false, message: "Printio could not save that day. Try again." };
  return { ok: true, rows: got.day.studies.map((s) => ({ study: s.study, portion: s.portion, sections: s.sections })) };
}

/** The day's studies, from Printio's saved text (fetched from the source the first time anyone asks for the day). */
export async function dailyDayAction(date: string): Promise<{ ok: true; items: DailyDayItem[] } | Failure> {
  const who = await libraryGate();
  if ("ok" in who) return who;
  if (!validDate(date)) return { ok: false, message: "Choose a date." };

  const day = await ensureDay(createServiceRoleClient(), date, who.userId);
  if (!day.ok) return day;
  const items: DailyDayItem[] = [];
  for (const study of OFFERED_STUDIES) {
    const row = day.rows.find((r) => r.study === study);
    if (row) items.push({ study, label: STUDY_LABELS[study], portion: row.portion });
  }
  return { ok: true, items };
}

export interface BuildDailyInput {
  date: string;
  studies: OfferedStudy[];
  language: Language;
  sheet: "letter" | "tabloid";
}
export type BuildDailyResult =
  | { ok: true; pdfBase64: string; fileName: string; pages: number; fontSize: number; direction: "ltr" | "rtl" }
  | Failure;

/** Builds the filled-page booklet PDF from the saved text; the print page then folds it into a booklet. */
export async function buildDailyBookletAction(input: BuildDailyInput): Promise<BuildDailyResult> {
  const who = await libraryGate();
  if ("ok" in who) return who;
  const { date, studies, language, sheet } = input ?? ({} as BuildDailyInput);
  if (!validDate(date)) return { ok: false, message: "Choose a date." };
  if (!Array.isArray(studies) || studies.length === 0 || studies.length > OFFERED_STUDIES.length || !studies.every(isOfferedStudy) || new Set(studies).size !== studies.length) {
    return { ok: false, message: "Choose what to print." };
  }
  if (language !== "he" && language !== "en" && language !== "both") return { ok: false, message: "Choose Hebrew, English or both." };
  if (sheet !== "letter" && sheet !== "tabloid") return { ok: false, message: "Choose the sheet size." };

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `daily_build:user:${who.userId}`,
    p_max_count: 30,
    p_window_seconds: 10 * 60,
  });
  if (!limitError && allowed === false) return { ok: false, message: "That is a lot of booklets at once. Wait a few minutes and try again." };

  const day = await ensureDay(db, date, who.userId);
  if (!day.ok) return day;
  const byStudy = new Map(day.rows.map((r) => [r.study, r]));
  const ordered = OFFERED_STUDIES.filter((s) => studies.includes(s));
  const missing = ordered.filter((s) => !byStudy.has(s));
  if (missing.length > 0) {
    return { ok: false, message: `${missing.map((s) => STUDY_LABELS[s]).join(" and ")} ${missing.length === 1 ? "is" : "are"} not in the source for that day.` };
  }

  const tabloid = sheet === "tabloid";
  const built = await buildFilledPdf({
    title: `Daily Study - ${longDate(date)}`,
    items: ordered.map((s) => ({ title: `${STUDY_LABELS[s]} - ${byStudy.get(s)!.portion}`, sections: Array.isArray(byStudy.get(s)!.sections) ? byStudy.get(s)!.sections : [] })),
    language,
    page: tabloid ? { width: 612, height: 792 } : { width: 396, height: 612 },
    margin: tabloid ? 40 : 28,
    credit: DAILY_CREDIT,
  });
  return {
    ok: true,
    pdfBase64: Buffer.from(built.bytes).toString("base64"),
    fileName: `Daily study ${date}.pdf`,
    pages: built.pages,
    fontSize: built.fontSize,
    direction: language === "he" ? "rtl" : "ltr",
  };
}
