import { parse, type HTMLElement } from "node-html-parser";
import type { DailyStudy } from "./feed";
import { isCheckPage, type StudyBlock, type StudySection, type StudyText } from "./page";

/**
 * Reads the booklet page of "Chitas & Rambam" (chitas-site.vercel.app), the daily study builder Chabad.org pointed the owner to.
 * Its `/shiur` page is plain server-rendered HTML for the days asked for, with each study as a section of Hebrew / English rows,
 * and answers an ordinary request (no check), so Printio asks it once per day and keeps the text (see docs/daily-study.md).
 * Pure: it takes HTML and returns text only (no markup, scripts or markers). Markup it does not recognise gives null, never an
 * error: if the site changes, the screen says the source looks different today rather than breaking.
 */

export const SHIUR_ORIGIN = "https://chitas-site.vercel.app";

export interface ShiurDay {
  /** ISO date. */
  date: string;
  studies: StudyText[];
}

/** The site's own names for the studies, mapped to the library's. Anything else on the page (Sotah, Shnayim Mikra) is ignored. */
const STUDY_KEYS: Record<string, DailyStudy> = {
  chumash: "chumash",
  tanya: "tanya",
  hayomYom: "hayomyom",
  // The site marks the three-chapter Rambam simply "rambam".
  rambam: "rambam3",
  rambam3: "rambam3",
  rambam1: "rambam1",
};

/** The page address for one day, half-size booklet, with the five studies the library offers. */
export function shiurUrl(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error("Date must look like 2026-11-02.");
  const q = new URLSearchParams({ from: isoDate, to: isoDate, paper: "half", order: "day", textLayout: "hebrew-left", chumash: "1", tanya: "1", hayomYom: "1", rambam3: "1", rambam1: "1" });
  return `${SHIUR_ORIGIN}/shiur?${q.toString()}`;
}

const MARKERS = ".chumash-inline-marker, .hebrew-inline-marker, .hebrew-marker, .middle-marker";

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The text of one side of a row (Hebrew or English), with nothing of the page's markup. */
function textOf(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  el.querySelectorAll("script, style, noscript, sup, [class*=ootnote]").forEach((n) => n.remove());
  return clean(el.text);
}

/** The verse / halacha number the site shows for a row, in Hebrew letters. */
function numberOf(row: HTMLElement): string | undefined {
  for (const m of row.querySelectorAll(MARKERS)) {
    const t = clean(m.text);
    if (t) return t;
  }
  return undefined;
}

function rowBlock(row: HTMLElement): StudyBlock | null {
  const num = numberOf(row);
  row.querySelectorAll(MARKERS).forEach((n) => n.remove());
  const he = textOf(row.querySelector(".hebrew-text"));
  const en = textOf(row.querySelector(".english-text"));
  if (!he && !en) return null;
  return { kind: "verse", ...(num ? { num } : {}), he, en };
}

function rashiBlock(box: HTMLElement): StudyBlock | null {
  const content = box.querySelector(".rashi-content") ?? box;
  const he = textOf(content.querySelector(".hebrew-text"));
  const en = textOf(content.querySelector(".english-text"));
  const leadHe = textOf(content.querySelector(".rashi-title-hebrew"));
  const leadEn = textOf(content.querySelector(".rashi-title-english"));
  if (!he && !en) return null;
  return { kind: "rashi", he, en, ...(leadHe ? { leadHe } : {}), ...(leadEn ? { leadEn } : {}) };
}

export function parseShiurPage(html: string): ShiurDay | null {
  if (isCheckPage(html)) return null;
  const root = parse(html);
  root.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
  const studies: StudyText[] = [];
  let date = "";

  for (const card of root.querySelectorAll("section.section-card")) {
    const marker = /CHITASPAGE__(\w+?)_(\d{4})_(\d{2})_(\d{2})__/.exec(card.querySelector(".pdf-page-marker")?.text ?? "");
    if (!marker) continue;
    date ||= `${marker[2]}-${marker[3]}-${marker[4]}`;
    const study = STUDY_KEYS[marker[1] ?? ""];
    if (!study) continue;

    const portion = clean(card.querySelector("h3")?.text ?? "") || clean(card.querySelector("h2")?.text ?? "");
    const sections: StudySection[] = [];
    let current: StudySection | null = null;
    let heading = "";
    for (const el of card.querySelectorAll(".chapter-heading, .chumash-row, .rashi-box, .two-column-row, .rambam-row")) {
      if (el.classList.contains("chapter-heading")) {
        // The portion line (also an h3 on the Rambam pages) is not a chapter.
        if (el.tagName === "H3" || el.tagName === "DIV") heading = clean(el.text);
        current = null;
        continue;
      }
      const block = el.classList.contains("rashi-box") ? rashiBlock(el) : rowBlock(el);
      if (!block) continue;
      if (!current) {
        current = { heading, blocks: [] };
        sections.push(current);
      }
      current.blocks.push(block);
    }
    if (sections.length > 0 && portion) studies.push({ study, portion, sections });
  }
  return date && studies.length > 0 ? { date, studies } : null;
}
