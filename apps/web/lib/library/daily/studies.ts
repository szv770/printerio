import type { DailyStudy } from "./feed";

/** The studies the library offers, in the order they print. */
export const OFFERED_STUDIES = ["chumash", "tanya", "rambam1", "rambam3"] as const satisfies readonly DailyStudy[];
export type OfferedStudy = (typeof OFFERED_STUDIES)[number];

export const STUDY_LABELS: Record<OfferedStudy, string> = {
  chumash: "Chumash with Rashi",
  tanya: "Tanya",
  rambam1: "Rambam (1 chapter)",
  rambam3: "Rambam (3 chapters)",
};

export function isOfferedStudy(s: unknown): s is OfferedStudy {
  return typeof s === "string" && (OFFERED_STUDIES as readonly string[]).includes(s);
}

/** Shown at the end of every daily study booklet; Chabad.org allows printing in yeshivos and asked for nothing more than we give. */
export const DAILY_CREDIT = "Text courtesy of Chabad.org, printed with permission. Thank you.";

/** "Sunday, November 1, 2026" for an ISO date, independent of the server's time zone. */
export function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
