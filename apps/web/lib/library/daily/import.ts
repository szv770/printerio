import { parse } from "node-html-parser";
import type { DailyDay, DailyStudy } from "./feed";
import { isCheckPage, parseStudyPage, type StudySection } from "./page";

/**
 * Turns a study page a person saved from their own browser ("Webpage, HTML only") into a row for `library_daily_texts`.
 * Chabad.org shows automated visitors a Cloudflare check that we never get past, so a person opens the page and this takes
 * the saved file. Pure: no network. The caller hands in the feed for the chosen date, and the page must be the portion that
 * feed names for that study, so a page cannot be saved under the wrong day.
 */

export interface DailyRow {
  study: DailyStudy;
  study_date: string;
  portion: string;
  sections: StudySection[];
  source_url: string;
}

export type PrepareResult = { ok: true; row: DailyRow } | { ok: false; message: string };

/** Which of the offered studies this page is, from the page's own heading. */
export function detectStudy(html: string): DailyStudy | null {
  const h1 = parse(html).querySelector("h1")?.text.replace(/\s+/g, " ").trim() ?? "";
  if (/^Daily Tanya/i.test(h1)) return "tanya";
  if (/^Chumash with Rashi/i.test(h1) || /^Daily Chumash with Rashi/i.test(h1)) return "chumash";
  if (/^Rambam - 1 Chapter/i.test(h1)) return "rambam1";
  if (/^Rambam - 3 Chapters?/i.test(h1)) return "rambam3";
  return null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+with rashi\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function prepareImport(html: string, feed: DailyDay): PrepareResult {
  if (isCheckPage(html)) {
    return { ok: false, message: "That file is Chabad.org's \"Just a moment\" check, not the study page. Open the study page in your own browser, wait until the text shows, then save it." };
  }
  const study = detectStudy(html);
  if (!study) return { ok: false, message: "That does not look like a Chabad.org daily Chumash, Tanya or Rambam page." };
  const item = feed.items.find((i) => i.study === study);
  if (!item) return { ok: false, message: "Chabad.org's list for that day has no such study." };
  const page = parseStudyPage(html, study);
  if (page.sections.length === 0) return { ok: false, message: "Printio could not read any text on that page. Save the page again once it has fully loaded." };
  if (norm(page.portion) !== norm(item.portion)) {
    return { ok: false, message: `That page is for a different day. Chabad.org's list for ${feed.date} says "${item.portion}", but the page says "${page.portion}".` };
  }
  return { ok: true, row: { study, study_date: feed.date, portion: item.portion, sections: page.sections, source_url: item.url } };
}
