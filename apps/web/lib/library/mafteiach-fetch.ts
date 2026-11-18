import "server-only";
import { parseEntryPage, parseLikkutSichos, parseListPage, type EntrySection, type LikkutPage, type ListPage } from "@printio/shared/library/mafteiach-parse";
import { decodeEmbeddedHtml, HOST, libraryPageUrl, MAX_PAGE_BYTES, TIMEOUT_MS, type PageRef } from "@printio/shared/library/mafteiach-fetch";

/**
 * Loads pages of mafteiach.app for the library browser. The site is fixed (never taken from the user) and only a few page
 * shapes are allowed, so nothing a person types can point the server at another address. Pages are cached for an hour
 * (the library changes slowly, and this keeps us a polite visitor), size- and time-limited, and read as text.
 */

export interface LibraryDeps {
  fetchPage?: (url: string) => Promise<Response>;
}

async function defaultFetchPage(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "user-agent": "Printio/1.0 (print library browser)", accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    next: { revalidate: 3600 },
  } as RequestInit);
  // Whatever the site redirects to must still be the library itself.
  if (res.url && new URL(res.url).origin !== HOST) throw new Error("redirected away from the library");
  return res;
}

type Loaded = { ok: true; html: string } | { ok: false; message: string };

async function load(ref: PageRef, deps: LibraryDeps): Promise<Loaded> {
  const url = libraryPageUrl(ref);
  if (!url) return { ok: false, message: "That library page address is not allowed." };
  let res: Response;
  try {
    res = await (deps.fetchPage ?? defaultFetchPage)(url);
  } catch {
    return { ok: false, message: "Printio could not reach the library right now. Try again in a minute." };
  }
  if (res.status === 404) return { ok: false, message: "Printio could not find that page in the library." };
  if (!res.ok) return { ok: false, message: `The library answered with an error (${res.status}). Try again later.` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_PAGE_BYTES) return { ok: false, message: "That library page is too large for Printio to read." };
  return { ok: true, html: decodeEmbeddedHtml(new TextDecoder().decode(bytes)) };
}

const DIFFERENT = "The library page looks different today, so Printio cannot read it. Tell the Printio team.";

export async function loadLikkutVolume(volume: number, deps: LibraryDeps = {}): Promise<{ ok: true; page: LikkutPage } | { ok: false; message: string }> {
  const got = await load({ kind: "likkutei", volume }, deps);
  if (!got.ok) return got;
  const page = parseLikkutSichos(got.html);
  return page.parshiyos.length > 0 ? { ok: true, page } : { ok: false, message: DIFFERENT };
}

export async function loadList(ref: { section: "maamorim" | "all"; year?: string }, deps: LibraryDeps = {}): Promise<{ ok: true; page: ListPage } | { ok: false; message: string }> {
  const got = await load({ kind: "list", ...ref }, deps);
  if (!got.ok) return got;
  const page = parseListPage(got.html);
  return page.years.length > 0 || page.entries.length > 0 ? { ok: true, page } : { ok: false, message: DIFFERENT };
}

export async function loadEntry(path: string, deps: LibraryDeps = {}): Promise<{ ok: true; sections: EntrySection[] } | { ok: false; message: string }> {
  const got = await load({ kind: "entry", path }, deps);
  if (!got.ok) return got;
  return { ok: true, sections: parseEntryPage(got.html) };
}
