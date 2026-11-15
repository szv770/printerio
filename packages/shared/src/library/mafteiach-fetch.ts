/**
 * The pure half of the library's page loader: the one allowed site, the allowed page shapes, the address builder and the
 * decoder for pages that carry their HTML inside a script. No network and no framework code, so the website and the print
 * server build exactly the same addresses. (The website's `fetch` wrapper stays in apps/web/lib/library/mafteiach-fetch.ts.)
 */

export const HOST = "https://www.mafteiach.app";
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;
/** Hebrew years the library could plausibly hold (5600 to 5899), alone or as a range like 5690_5710. */
export const YEAR = /^5[6-8]\d{2}(_5[6-8]\d{2})?$/;
export const MAAMOR_PATH = /^\/maamorim\/\d{1,5}$/;
export const FARBRENGEN_PATH = /^\/all\/\d{4}-\d{1,2}[A-Za-z]?-\d{1,2}[A-Za-z]?$/;

export type PageRef =
  | { kind: "likkutei"; volume: number }
  | { kind: "list"; section: "maamorim" | "all"; year?: string }
  | { kind: "entry"; path: string };

/** The one address for a page, or null when the request is not one of the allowed shapes. */
export function libraryPageUrl(ref: PageRef): string | null {
  if (ref.kind === "likkutei") return Number.isInteger(ref.volume) && ref.volume >= 1 && ref.volume <= 99 ? `${HOST}/likkutei_sichos/by_volume/${ref.volume}` : null;
  if (ref.kind === "list") {
    if (ref.year === undefined) return `${HOST}/${ref.section}`;
    if (!YEAR.test(ref.year)) return null;
    return ref.section === "maamorim" ? `${HOST}/maamorim?order=by_year&year=${ref.year}` : `${HOST}/all/by_year/${ref.year}`;
  }
  return MAAMOR_PATH.test(ref.path) || FARBRENGEN_PATH.test(ref.path) ? `${HOST}${ref.path}` : null;
}

/** Some pages carry their HTML as a string inside a script. Decode that string as TEXT (nothing from the site is ever run). */
export function decodeEmbeddedHtml(source: string): string {
  const start = source.indexOf("let html = ");
  if (start < 0) return source;
  const end = source.indexOf('";\n', start);
  if (end < 0) return source;
  return source.slice(start + 12, end).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c[0] === "u" && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[c] ?? c;
  });
}
