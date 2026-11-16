"use server";

import { revalidatePath } from "next/cache";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { fetchDailyFeed } from "@/lib/library/daily/feed-fetch";
import { fetchShiurDay } from "@/lib/library/daily/source-fetch";
import { prepareImport } from "@/lib/library/daily/import";
import type { Json } from "@/lib/database.types";
import { canUseLinks } from "@/lib/sources/access";
import { libraryViaServer, onlineFetcherExists } from "@/lib/library/cache";
import { buildFilledPdf, type ColumnSplit, type Language } from "@/lib/library/daily/fill";
import type { StudySection } from "@printio/shared/library/daily/page";
import { checkRoleFontIds, loadRoleFonts } from "@/lib/booklet/custom-font";
import { listOrgFonts, type OrgFontOption } from "@/lib/booklet/org-fonts";
import { loadOrgFontFacts } from "@/lib/booklet/org-font-facts";
import type { FontFacts } from "@/lib/booklet/font-families";
import { ENGLISH_FONT_CHOICES } from "@/lib/booklet/fonts/english";
import { coverDates, mergeDays, type Arrange, type DayText } from "@/lib/library/daily/merge";
import { datesBetween, DAILY_CREDIT, isOfferedStudy, longDate, MAX_BOOKLET_DAYS, OFFERED_STUDIES, STUDY_LABELS, type OfferedStudy } from "@/lib/library/daily/studies";

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
async function libraryGate(): Promise<{ userId: string; organizationId: string } | Failure> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, message: "Your account is not part of an organization yet." };
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) {
    return { ok: false, message: "The library is being tested with admins first. Ask an admin to switch early tools on for you." };
  }
  return { userId: session.userId, organizationId: session.membership.organization_id };
}

/**
 * The fonts for the form's dropdowns (names only, never the font files): everything the organization's admins uploaded (each
 * with hasHebrew / hasLatin, so the form can offer Hebrew fonts and English fonts in the right lists) and the English fonts
 * bundled with Printio.
 */
export async function dailyFontsAction(): Promise<
  | {
      ok: true;
      fonts: OrgFontOption[];
      englishFonts: { id: string; name: string }[];
      /** The family and weight of each uploaded font, by font id, read from the font files (see lib/booklet/font-families.ts). */
      faces: Record<string, FontFacts>;
    }
  | Failure
> {
  const who = await libraryGate();
  if ("ok" in who) return who;
  const fonts = await listOrgFonts(who.organizationId);
  let faces: Record<string, FontFacts> = {};
  if (fonts.length > 0) {
    try {
      faces = await loadOrgFontFacts(createServiceRoleClient(), who.organizationId, fonts);
    } catch {
      // Weights are a convenience: without them every font is its own family, as before.
    }
  }
  return { ok: true, fonts, englishFonts: ENGLISH_FONT_CHOICES, faces };
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

const NOT_SAVED_YET = "That day has not been saved yet. Your print server saves the next week every night; try again later.";
const NOT_SAVED_NO_SERVER = "That day has not been saved yet, and no print server is online to save it right now. Try again when it is on.";
const TOO_MANY_DAYS = "That is a lot of days at once. Wait a few minutes and try again.";

/**
 * The day's saved text. When nothing is saved for the date yet, Printio asks the source once (as a person opening the page and
 * making a booklet would), saves every study on it for everyone, and uses that.
 * With the switch LIBRARY_VIA_SERVER on it never asks the source: the owner's print server saves the next week every night
 * (docs/PHASE-C-PLAN.md, C1d), so a day that is not saved is answered with a plain message (and says when no print server is online).
 */
async function ensureDay(
  db: ReturnType<typeof createServiceRoleClient>,
  date: string,
  userId: string,
  /** Only for a booklet of several days: `savedOnly` never asks the source; `beforeFetch` runs just before the source is asked. */
  opts: { savedOnly?: boolean; beforeFetch?: () => Promise<void> } = {},
): Promise<{ ok: true; rows: DayRow[] } | Failure> {
  const { data } = await db.from("library_daily_texts").select("study, portion, sections").eq("study_date", date);
  const saved = (data ?? []) as unknown as DayRow[];
  if (saved.length > 0) return { ok: true, rows: saved };
  if (opts.savedOnly) return { ok: false, message: "That day has not been saved yet." };

  if (libraryViaServer()) return { ok: false, message: (await onlineFetcherExists(db)) ? NOT_SAVED_YET : NOT_SAVED_NO_SERVER };

  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `daily_fetch:user:${userId}`,
    p_max_count: 12,
    p_window_seconds: 10 * 60,
  });
  if (!limitError && allowed === false) return { ok: false, message: TOO_MANY_DAYS };

  await opts.beforeFetch?.();
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
  /** The day, or the first day of several. */
  date: string;
  /** The last day (up to 7 days in one booklet); leave out for one day. */
  toDate?: string | null;
  /** Several days: "day" prints day 1's studies, then day 2's...; "study" prints every day's Chumash, then every day's Tanya... Default "day". */
  arrange?: Arrange;
  /** Several days: leave out the days (or a study of a day) that are not available instead of stopping. Default off. */
  skipMissing?: boolean;
  studies: OfferedStudy[];
  language: Language;
  sheet: "letter" | "tabloid";
  /** Both languages side by side: how the width is shared. Default "auto" (measured; English usually gets more). */
  columns?: ColumnSplit;
  /** An uploaded Hebrew font of the member's organization (the Hebrew text); leave out for Printio's own (Ezra SIL). */
  fontId?: string | null;
  /** An uploaded Hebrew font for the Hebrew titles (the family's Bold); leave out to use the same font as the text. */
  titleFontId?: string | null;
  /** An uploaded Hebrew font for Rashi; leave out to use the same font as the text. */
  rashiFontId?: string | null;
  /** The English font: an id from ENGLISH_FONT_CHOICES ("david-libre", ...) or the id of an uploaded English font; leave out for David Libre. */
  latinFontId?: string | null;
  /** The English font for titles: an uploaded font's id, or a bundled one ("eb-garamond:bold"); leave out for the English font's own bold. */
  latinTitleFontId?: string | null;
  /** The English font for Rashi, likewise; leave out to use the English font. */
  latinRashiFontId?: string | null;
}
export type BuildDailyResult =
  | {
      ok: true;
      pdfBase64: string;
      fileName: string;
      pages: number;
      fontSize: number;
      direction: "ltr" | "rtl";
      fontWarning?: string;
      /** Days (or one study of a day) that were not available and were left out, in plain words. Only with skipMissing. */
      skipped?: string[];
    }
  | Failure;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the filled-page booklet PDF from the saved text; the print page then folds it into a booklet. */
export async function buildDailyBookletAction(input: BuildDailyInput): Promise<BuildDailyResult> {
  const who = await libraryGate();
  if ("ok" in who) return who;
  const { date, toDate, studies, language, sheet, fontId, titleFontId, rashiFontId, latinFontId, latinTitleFontId, latinRashiFontId } = input ?? ({} as BuildDailyInput);
  const arrange = input?.arrange ?? "day";
  const columns = input?.columns ?? "auto";
  const skipMissing = input?.skipMissing === true;
  if (!validDate(date)) return { ok: false, message: "Choose a date." };
  if (toDate != null && toDate !== "" && !validDate(toDate)) return { ok: false, message: "Choose the last day." };
  const dates = datesBetween(date, toDate || date);
  if (!dates) {
    return { ok: false, message: Date.parse(toDate!) < Date.parse(date) ? "The last day is before the first day." : `One booklet holds up to ${MAX_BOOKLET_DAYS} days. Choose a shorter range.` };
  }
  if (!Array.isArray(studies) || studies.length === 0 || studies.length > OFFERED_STUDIES.length || !studies.every(isOfferedStudy) || new Set(studies).size !== studies.length) {
    return { ok: false, message: "Choose what to print." };
  }
  if (language !== "he" && language !== "en" && language !== "both") return { ok: false, message: "Choose Hebrew, English or both." };
  if (sheet !== "letter" && sheet !== "tabloid") return { ok: false, message: "Choose the sheet size." };
  if (arrange !== "day" && arrange !== "study") return { ok: false, message: "Choose how to arrange the days." };
  if (columns !== "auto" && columns !== "even" && columns !== "wider" && columns !== "much") return { ok: false, message: "Choose the column widths." };
  const fontIds = { fontId, titleFontId, rashiFontId, latinFontId, latinTitleFontId, latinRashiFontId };
  const badFont = checkRoleFontIds(fontIds);
  if (badFont) return { ok: false, message: badFont };

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `daily_build:user:${who.userId}`,
    p_max_count: 30,
    p_window_seconds: 10 * 60,
  });
  if (!limitError && allowed === false) return { ok: false, message: "That is a lot of booklets at once. Wait a few minutes and try again." };

  // Each day goes through the same one-day path as ever (the shared saved text first, then the per-person limit and one request
  // to the source, or with LIBRARY_VIA_SERVER the saved text only). One day that fails stops a one-day booklet with its own message.
  const days: DayText[] = [];
  let fetched = 0;
  let sourceFailed = false;
  for (const d of dates) {
    const day = await ensureDay(db, d, who.userId, {
      // After the source failed once in this booklet it is not asked again: the remaining days are used only if already saved.
      savedOnly: sourceFailed,
      // Several days that all need fetching are spaced out, as a person clicking through them would be.
      beforeFetch: async () => {
        if (fetched++ > 0) await pause(1200);
      },
    });
    if (day.ok) {
      days.push({ date: d, rows: day.rows });
      continue;
    }
    if (dates.length === 1) return { ok: false, message: day.message };
    if (day.message === TOO_MANY_DAYS) return { ok: false, message: day.message };
    if (!libraryViaServer()) sourceFailed = true;
    days.push({ date: d, rows: null });
  }
  const merged = mergeDays({ days, studies, arrange, skipMissing });
  if (!merged.ok) return merged;

  const fonts = await loadRoleFonts(db, who.organizationId, fontIds);
  if (!fonts.ok) return fonts;
  const { hebrewFont, titleFont, rashiFont, latinFont, latinRashiFont, hebrewFontName: fontName } = fonts;

  const tabloid = sheet === "tabloid";
  const first = merged.dates[0]!;
  const last = merged.dates[merged.dates.length - 1]!;
  const when = coverDates(merged.dates);
  let built: Awaited<ReturnType<typeof buildFilledPdf>>;
  try {
    built = await buildFilledPdf({
      title: "Daily Study",
      titleHe: "לימוד יומי",
      items: merged.items,
      language,
      columns,
      page: tabloid ? { width: 612, height: 792 } : { width: 396, height: 612 },
      margin: tabloid ? 40 : 28,
      credit: DAILY_CREDIT,
      cover: { ...when, contents: merged.contents },
      footer: { text: when.dateEn, textHe: when.dateHe },
      hebrewFont,
      titleFont,
      rashiFont,
      latinFont,
      latinRashiFont,
    });
  } catch (err) {
    if ((hebrewFont || titleFont || rashiFont || latinFont || latinRashiFont) && err instanceof Error && err.message.startsWith("That font could not be read")) return { ok: false, message: err.message };
    throw err;
  }
  const lacks = [built.missingMarks.vowels && "vowel points", built.missingMarks.cantillation && "cantillation marks (trop)"].filter(Boolean).join(" and ");
  return {
    ok: true,
    pdfBase64: Buffer.from(built.bytes).toString("base64"),
    fileName: first === last ? `Daily study ${first}.pdf` : `Daily study ${first} to ${last}.pdf`,
    pages: built.pages,
    fontSize: built.fontSize,
    direction: language === "he" ? "rtl" : "ltr",
    ...(lacks ? { fontWarning: `${fontName || "The chosen Hebrew font"} has no ${lacks}, so those marks in this text are missing on the page. Choose a font that has them if you need them.` } : {}),
    ...(merged.skipped.length > 0 ? { skipped: merged.skipped } : {}),
  };
}

