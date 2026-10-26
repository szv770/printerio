import { matchesQuery } from "./labels";
import { SIE_WEEKLY, type SieEntry } from "./sie-weekly";

export interface SieGroup {
  chelek: string;
  sefarim: { sefer: string; entries: SieEntry[] }[];
}

/** SIE Weekly grouped by volume (chelek) then book (sefer), in list order, optionally narrowed by a search (title, book or volume). */
export function groupSie(entries: readonly SieEntry[], query = ""): SieGroup[] {
  const groups: SieGroup[] = [];
  for (const e of entries) {
    if (!matchesQuery([e.title, e.sefer, `chelek ${e.chelek}`], query)) continue;
    let g = groups.find((x) => x.chelek === e.chelek);
    if (!g) groups.push((g = { chelek: e.chelek, sefarim: [] }));
    let s = g.sefarim.find((x) => x.sefer === e.sefer);
    if (!s) g.sefarim.push((s = { sefer: e.sefer, entries: [] }));
    s.entries.push(e);
  }
  return groups;
}

/** The page in a Likkutei Sichos entry's label, e.g. "ח"א ע' 15 (לך לך)" -> 15. Null when there is none. */
export function likkutPageFromLabel(label: string): number | null {
  const m = /ע['\u05f3\u2019]\s*(\d{1,4})/.exec(label);
  return m ? Number(m[1]) : null;
}

/**
 * The English translations (SIE Weekly) of the sicha that starts on this page of this Likkutei Sichos volume. A translation
 * counts when its starting page is this page, or falls inside this sicha's pages (before the next sicha starts, `nextPage`),
 * because SIE sometimes names a page or two after the sicha's first.
 */
export function sieForLikkut(volume: number | null, page: number | null, entries: readonly SieEntry[] = SIE_WEEKLY, nextPage: number | null = null): SieEntry[] {
  if (volume === null || page === null) return [];
  return entries.filter((e) => e.volume === volume && e.page !== undefined && e.page >= page && (nextPage === null || e.page < nextPage));
}

/** The page range that skips SIE's cover, blank page and dedication pages ("4-18"); undefined when the whole file should be used. */
export function sieContentRange(e: Pick<SieEntry, "from" | "pageCount">): string | undefined {
  if (e.from === undefined || e.pageCount === undefined) return undefined;
  if (e.from <= 1 || e.from > e.pageCount) return undefined;
  return `${e.from}-${e.pageCount}`;
}
