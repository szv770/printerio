import type { SieEntry } from "./sie-weekly";

/** The columns of library_sie_entries (what an admin's "Check for new weeks" added beyond the saved copy in sie-weekly.ts). */
export interface SieRow {
  url: string;
  chelek: string;
  sefer: string;
  title: string;
  volume: number | null;
  page: number | null;
  from_page: number;
  to_page: number | null;
  page_count: number | null;
}

export function sieToRow(e: SieEntry): SieRow {
  return {
    url: e.url,
    chelek: e.chelek,
    sefer: e.sefer,
    title: e.title,
    volume: e.volume ?? null,
    page: e.page ?? null,
    from_page: e.from ?? 1,
    to_page: e.to ?? null,
    page_count: e.pageCount ?? null,
  };
}

export function sieFromRow(r: SieRow): SieEntry {
  return {
    chelek: r.chelek,
    sefer: r.sefer,
    title: r.title,
    url: r.url,
    ...(r.volume !== null ? { volume: r.volume } : {}),
    ...(r.page !== null ? { page: r.page } : {}),
    from: r.from_page,
    ...(r.to_page !== null ? { to: r.to_page } : {}),
    ...(r.page_count !== null ? { pageCount: r.page_count } : {}),
  };
}

/** The saved weeks first, then the added ones, each file once. */
export function mergeSie(saved: readonly SieEntry[], added: readonly SieEntry[]): SieEntry[] {
  const seen = new Set(saved.map((e) => e.url));
  return [...saved, ...added.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))];
}
