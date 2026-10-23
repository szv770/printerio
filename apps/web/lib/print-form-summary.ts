/**
 * One-line summaries for the print form: the live line above the Print button and the line each closed
 * section shows under its title. Pure and display-only; what is actually sent is decided by print-choices.ts.
 */
import type { BookletChoice, SidesChoice, StapleChoice } from "./print-choices";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 pages · 2 copies · double-sided · stapled". Pages are left out until a count is known. */
export function liveSummaryLine(c: {
  pages: number | null;
  copies: number;
  sides: SidesChoice;
  staple: StapleChoice;
  booklet: BookletChoice;
}): string {
  const parts: string[] = [];
  if (c.pages && c.pages > 0) parts.push(plural(c.pages, "page", "pages"));
  parts.push(plural(c.copies, "copy", "copies"));
  if (c.booklet !== "none") {
    parts.push("booklet");
  } else {
    parts.push(c.sides === "two" ? "double-sided" : "single-sided");
    if (c.staple !== "none") parts.push("stapled");
  }
  return parts.join(" · ");
}

/** Closed "Pages" section: "All pages" or "Pages 1-5, 8 (6 pages)". */
export function summarizePages(rangeText: string, _total: number | null, selected?: number | null): string {
  const text = rangeText.trim();
  if (!text) return "All pages";
  return selected && selected > 0 ? `Pages ${text} (${plural(selected, "page", "pages")})` : `Pages ${text}`;
}

/** Closed "Finishing" section. */
export function summarizeFinishing(c: { staple: StapleChoice; booklet: BookletChoice }): string {
  if (c.booklet !== "none") {
    return c.booklet === "right" ? "Booklet, bound on the right" : c.booklet === "left" ? "Booklet, bound on the left" : "Booklet";
  }
  if (c.staple === "top-left") return "Staple, top left";
  if (c.staple === "top-right") return "Staple, top right";
  if (c.staple === "profile") return "Staple";
  return "No stapling or booklet";
}

/** Closed "Paper & color" section. */
export function summarizePaperColor(c: { colorMode: "bw" | "color"; paperSize: string }): string {
  return `${c.colorMode === "color" ? "Colour" : "Black & white"}, ${c.paperSize}`;
}

/** Closed "Advanced" section. */
export function summarizeAdvanced(c: { punchAvailable: boolean; punch: boolean }): string {
  if (!c.punchAvailable) return "Saved choices";
  return c.punch ? "Hole punch on" : "Hole punch off";
}
