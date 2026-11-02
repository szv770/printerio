import type { DailyStudy } from "./feed";

/** The studies the library offers, in the order they print. */
export const OFFERED_STUDIES = ["chumash", "tanya", "hayomyom", "rambam3", "rambam1"] as const satisfies readonly DailyStudy[];
export type OfferedStudy = (typeof OFFERED_STUDIES)[number];

export const STUDY_LABELS: Record<OfferedStudy, string> = {
  chumash: "Chumash with Rashi",
  tanya: "Tanya",
  hayomyom: "Hayom Yom",
  rambam3: "Rambam (3 chapters)",
  rambam1: "Rambam (1 chapter)",
};

export function isOfferedStudy(s: unknown): s is OfferedStudy {
  return typeof s === "string" && (OFFERED_STUDIES as readonly string[]).includes(s);
}

/** Shown at the end of every daily study booklet; the text comes from Chabad.org's Daily Study through the Chitas & Rambam builder it pointed us to. */
export const DAILY_CREDIT = "Text courtesy of Chabad.org Daily Study, printed with permission. Thank you.";

/** "Sunday, November 1, 2026" for an ISO date, independent of the server's time zone. */
export function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
