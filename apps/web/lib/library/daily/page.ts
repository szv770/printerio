import { parse, type HTMLElement } from "node-html-parser";
import type { DailyStudy } from "./feed";

/**
 * Reads a saved Chabad.org daily study page (Chumash with Rashi, Tanya, Rambam) into plain text: Hebrew and English side by side.
 * Pure: it takes HTML and returns data, so it is tested against trimmed copies of the real pages. It keeps text only, never
 * markup, scripts or links, and it leaves out footnotes, footnote numbers and the "Quiz Yourself" questions. Markup it does
 * not recognise gives no sections, never an error: the caller treats that as "could not read this page".
 * It never fetches anything. Where the HTML comes from (a person's browser, or a slow fetch) is decided elsewhere, and the
 * site's Cloudflare check is never bypassed (see docs/daily-study.md).
 */

export type StudyBlockKind = "verse" | "rashi" | "note";

export interface StudyBlock {
  kind: StudyBlockKind;
  /** Verse / halacha number as the page shows it ("1"). */
  num?: string;
  he: string;
  en: string;
  /** Rashi only: the words of the verse being explained. */
  leadHe?: string;
  leadEn?: string;
}

export interface StudySection {
  heading: string;
  blocks: StudyBlock[];
}

export interface StudyText {
  study: DailyStudy;
  /** What is learned that day, as the page's own heading words it. */
  portion: string;
  sections: StudySection[];
}

const JUNK = "script, style, noscript, .footnote, a.footnote_ref";

/** True when the HTML is Cloudflare's "Just a moment..." check, not the page. */
export function isCheckPage(html: string): boolean {
  return /<title>\s*Just a moment/i.test(html);
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function text(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  el.querySelectorAll("a.versenum, .co_VerseNum").forEach((n) => n.remove());
  return clean(el.text);
}

function numOf(el: HTMLElement | null | undefined): string | undefined {
  const n = clean(el?.querySelector("a.versenum, .co_VerseNum")?.text ?? "");
  return n || undefined;
}

export function parseStudyPage(html: string, study: DailyStudy): StudyText {
  const root = parse(html);
  root.querySelectorAll(JUNK).forEach((n) => n.remove());

  const sections: StudySection[] = [];
  let portion = "";
  let heading = "";
  let skipping = false;
  let current: StudySection | null = null;

  const add = (block: StudyBlock) => {
    if (!block.he && !block.en) return;
    if (!current || current.heading !== heading) {
      current = { heading, blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  };

  for (const el of root.querySelectorAll("h2, .article-body")) {
    if (el.tagName === "H2") {
      const t = clean(el.text);
      if (!portion && t && !/^quiz/i.test(t)) portion = t;
      skipping = /^quiz/i.test(t);
      if (!skipping) heading = t;
      continue;
    }
    if (skipping) continue;
    for (const item of el.querySelectorAll("h3, .verse-wrapper, tr.Co_Verse, tr.Co_Rashi")) {
      if (item.tagName === "H3") {
        heading = clean(item.text);
      } else if (item.classList.contains("verse-wrapper")) {
        const num = numOf(item);
        const en = text(item.querySelector(".co_verse"));
        const he = text(item.querySelector(".alternate_he"));
        const note = text(item.querySelector(".co_commentary"));
        add({ kind: "verse", num, he, en });
        add({ kind: "note", he: "", en: note });
      } else if (item.classList.contains("Co_Verse")) {
        const cells = item.querySelectorAll("td");
        const enCell = cells.find((c) => !c.classList.contains("hebrew") && !c.classList.contains("Co_Spacer"));
        const heCell = cells.find((c) => c.classList.contains("hebrew"));
        add({ kind: "verse", num: numOf(enCell), en: text(enCell?.querySelector(".co_VerseText")), he: text(heCell?.querySelector(".co_VerseText")) });
      } else if (item.classList.contains("Co_Rashi")) {
        const cells = item.querySelectorAll("td");
        const enCell = cells.find((c) => !c.classList.contains("hebrew") && !c.classList.contains("Co_Spacer"));
        const heCell = cells.find((c) => c.classList.contains("hebrew"));
        add({
          kind: "rashi",
          leadEn: text(enCell?.querySelector(".co_RashiTitle")),
          en: text(enCell?.querySelector(".co_RashiText")),
          leadHe: text(heCell?.querySelector(".co_RashiTitle")),
          he: text(heCell?.querySelector(".co_RashiText")),
        });
      }
    }
  }
  return { study, portion, sections };
}
