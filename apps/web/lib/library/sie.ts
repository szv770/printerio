import { matchesQuery } from "./labels";
import type { SieEntry } from "./sie-weekly";

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
