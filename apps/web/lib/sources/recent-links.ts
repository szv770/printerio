/**
 * "Your last 5 links" for Print from a link. This lives in the browser's own storage only: it is never sent to the
 * server and never shared. Because a share link can BE the secret (anyone holding it can open the file), the rules are
 * deliberately conservative:
 *   - the file name and the site's host are always kept (they identify the entry);
 *   - the link itself is kept only when it has no query string at all, or only query parameters from a short list of
 *     harmless display options. Any other parameter (rlkey, resourcekey, authkey, token, sig, key, e, st, ...) means the
 *     link is NOT stored and the entry cannot be reused with one tap: the person pastes it again;
 *   - a link with a sign-in in it, a "#fragment" or a non-https address is never stored;
 *   - the list is capped, de-duplicated, and anything unreadable in storage is dropped.
 * An allow-list (not a block-list of "secret-looking" names) is used on purpose: an unknown parameter is assumed secret.
 */
export interface RecentLink {
  /** The site, e.g. "www.dropbox.com". */
  host: string;
  /** The file's name as shown to the person. */
  name: string;
  /** The pasted link, only when it is safe to keep; otherwise null (the entry is a reminder, not a shortcut). */
  link: string | null;
  /** When it was fetched (ms since 1970). */
  at: number;
}

export const RECENT_LINKS_KEY = "printio.recentLinks.v1";
export const MAX_RECENT_LINKS = 5;

const HARMLESS_PARAMS = new Set(["usp", "dl", "tab", "page", "pli", "export", "format"]);

export function linkToRemember(original: URL): string | null {
  if (original.protocol !== "https:" || original.username || original.password || original.hash) return null;
  for (const name of original.searchParams.keys()) if (!HARMLESS_PARAMS.has(name.toLowerCase())) return null;
  return original.toString();
}

export function recentEntry(original: URL, fileName: string, now: number): RecentLink {
  return { host: original.hostname, name: fileName.slice(0, 120), link: linkToRemember(original), at: now };
}

/** Newest first, one entry per link (or per host and name when the link is not kept), at most five. */
export function addRecent(list: readonly RecentLink[], entry: RecentLink, max = MAX_RECENT_LINKS): RecentLink[] {
  const same = (a: RecentLink) => (entry.link && a.link ? a.link === entry.link : a.host === entry.host && a.name === entry.name);
  return [entry, ...list.filter((a) => !same(a))].slice(0, max);
}

/** Reads what was stored. Anything that is not exactly the shape written above is ignored, and a stored link is re-checked. */
export function parseRecent(raw: string | null): RecentLink[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentLink[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { host, name, link, at } = item as Record<string, unknown>;
    if (typeof host !== "string" || typeof name !== "string" || typeof at !== "number") continue;
    let safeLink: string | null = null;
    if (typeof link === "string") {
      try {
        safeLink = linkToRemember(new URL(link));
      } catch {
        safeLink = null;
      }
    }
    out.push({ host: host.slice(0, 253), name: name.slice(0, 120), link: safeLink, at });
    if (out.length >= MAX_RECENT_LINKS) break;
  }
  return out;
}
