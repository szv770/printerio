import { viewFromRow } from "./status";

/** A file the person submitted that has no print job yet, for the card at the top of My jobs. Filtered in JS so the query stays a plain indexed read. */
export interface PreparingCard {
  id: string;
  fileName: string;
  /** "preparing" is in progress or waiting; the others need the person to look (a question or a problem). */
  state: "preparing" | "needs_booklet_confirm" | "failed";
}

export function preparingCards(rows: { id: string; status: string; params: unknown; result: unknown }[]): PreparingCard[] {
  const cards: PreparingCard[] = [];
  for (const r of rows) {
    const v = viewFromRow(r, true);
    if (v.state === "preparing" || v.state === "needs_booklet_confirm" || v.state === "failed") cards.push({ id: r.id, fileName: v.fileName, state: v.state });
  }
  return cards;
}

/** Only the last day's files are listed (a waiting file expires after 24 hours). */
export const cardsSince = (nowMs: number = Date.now()): string => new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
