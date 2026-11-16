import type { StudySection } from "@printio/shared/library/daily/page";
import type { ContentsRow, FillItem } from "./fill";
import { CONTENTS_LABELS, dayAndMonth, longDate, OFFERED_STUDIES, STUDY_LABELS, weekday, type OfferedStudy } from "./studies";
import { CONTENTS_LABELS_HE, hebrewDate, hebrewPortionName, hebrewWeekday, STUDY_LABELS_HE } from "./titles-he";

/**
 * Puts the saved text of one or several days into one booklet. Pure: it is given each day's text (or that the day is not
 * available) and answers with the booklet's items in order, the front page's list of what is inside, and what was left out.
 *
 * Arrange "day": day 1's studies, then day 2's, ... (each day under its own heading). Arrange "study": every day's Chumash, then
 * every day's Tanya, ... (each study under its own heading). A booklet of one day has no such headings.
 * A day, or one study of a day, that is not available stops the booklet with a message that names it - unless `skipMissing`, when
 * it is left out and named in `skipped`.
 */

export type Arrange = "day" | "study";

export interface DayRow {
  study: string;
  portion: string;
  sections: StudySection[];
}

export interface DayText {
  date: string;
  /** The day's saved studies; null when the day is not available. */
  rows: DayRow[] | null;
}

export interface MergeInput {
  days: DayText[];
  studies: readonly OfferedStudy[];
  arrange: Arrange;
  skipMissing: boolean;
}

export type MergeResult =
  | {
      ok: true;
      items: FillItem[];
      contents: ContentsRow[];
      /** The days that are in the booklet, in order. */
      dates: string[];
      /** What was left out, in plain words ("Tuesday, November 17, 2026", "Tanya on Wednesday, November 18, 2026"). */
      skipped: string[];
    }
  | { ok: false; message: string };

export const SKIP_LABEL = "Skip days that are not available";

export function mergeDays(input: MergeInput): MergeResult {
  const ordered = OFFERED_STUDIES.filter((s) => input.studies.includes(s));
  const several = input.days.length > 1;
  const problems: string[] = [];
  const included: { date: string; rows: Map<OfferedStudy, DayRow> }[] = [];

  for (const day of input.days) {
    if (!day.rows) {
      problems.push(longDate(day.date));
      continue;
    }
    const byStudy = new Map(day.rows.map((r) => [r.study, r]));
    const have = new Map<OfferedStudy, DayRow>();
    const missing: OfferedStudy[] = [];
    for (const s of ordered) {
      const row = byStudy.get(s);
      if (row) have.set(s, row);
      else missing.push(s);
    }
    if (missing.length > 0 && !several && !input.skipMissing) {
      return { ok: false, message: `${missing.map((s) => STUDY_LABELS[s]).join(" and ")} ${missing.length === 1 ? "is" : "are"} not in the source for that day.` };
    }
    for (const s of missing) problems.push(`${STUDY_LABELS[s]} on ${longDate(day.date)}`);
    if (have.size > 0) included.push({ date: day.date, rows: have });
  }

  if (problems.length > 0 && !input.skipMissing) {
    return { ok: false, message: `Not available: ${problems.join("; ")}. Tick "${SKIP_LABEL}" to make the booklet without ${problems.length === 1 ? "it" : "them"}.` };
  }
  if (included.length === 0) return { ok: false, message: several ? "None of those days is available yet." : "That day is not available yet." };

  const grouped = included.length > 1;
  const byStudy = grouped && input.arrange === "study";
  const item = (date: string, s: OfferedStudy, row: DayRow): FillItem => {
    const portionHe = hebrewPortionName(s, row.portion);
    const sections = Array.isArray(row.sections) ? row.sections : [];
    const foot = { footer: longDate(date), footerHe: `${hebrewWeekday(date)}, ${hebrewDate(date)}` };
    if (byStudy) {
      // Under the study's own heading each part is named by its day.
      return {
        title: `${dayAndMonth(date)} - ${row.portion}`,
        titleHe: `${hebrewWeekday(date)}, ${hebrewDate(date)}${portionHe ? ` - ${portionHe}` : ""}`,
        sections,
        ...foot,
      };
    }
    return {
      title: `${STUDY_LABELS[s]} - ${row.portion}`,
      // The Hebrew title: the study name and, for the Chumash, the parsha - only when the source's portion line gave a name we know.
      titleHe: portionHe ? `${STUDY_LABELS_HE[s]} - ${portionHe}` : STUDY_LABELS_HE[s],
      sections,
      ...foot,
    };
  };

  const items: FillItem[] = [];
  const contents: ContentsRow[] = [];
  if (byStudy) {
    for (const s of ordered) {
      const days = included.filter((d) => d.rows.has(s));
      if (days.length === 0) continue;
      days.forEach((d, i) => {
        items.push({ ...item(d.date, s, d.rows.get(s)!), ...(i === 0 ? { groupTitle: STUDY_LABELS[s], groupTitleHe: STUDY_LABELS_HE[s] } : {}) });
      });
      contents.push({
        label: CONTENTS_LABELS[s],
        text: days.map((d) => weekday(d.date)).join(", "),
        labelHe: CONTENTS_LABELS_HE[s],
        textHe: days.map((d) => hebrewWeekday(d.date)).join(", "),
      });
    }
  } else {
    for (const d of included) {
      const studies = ordered.filter((s) => d.rows.has(s));
      studies.forEach((s, i) => {
        items.push({ ...item(d.date, s, d.rows.get(s)!), ...(grouped && i === 0 ? { groupTitle: longDate(d.date), groupTitleHe: `${hebrewWeekday(d.date)}, ${hebrewDate(d.date)}` } : {}) });
      });
      contents.push({
        label: weekday(d.date),
        text: studies.map((s) => CONTENTS_LABELS[s]).join(", "),
        labelHe: hebrewWeekday(d.date),
        textHe: studies.map((s) => CONTENTS_LABELS_HE[s]).join(", "),
      });
    }
  }
  return { ok: true, items, contents, dates: included.map((d) => d.date), skipped: problems };
}

/** The dates under the front page's title: one day, or the first and last day of several. */
export function coverDates(dates: readonly string[]): { dateEn: string; dateHe: string } {
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  if (first === last) return { dateEn: longDate(first), dateHe: `${hebrewWeekday(first)}, ${hebrewDate(first)}` };
  return { dateEn: `${longDate(first)} - ${longDate(last)}`, dateHe: `${hebrewDate(first)} - ${hebrewDate(last)}` };
}
