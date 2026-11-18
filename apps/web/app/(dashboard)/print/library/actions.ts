"use server";

import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { canUseLinks } from "@/lib/sources/access";
import { loadEntry, loadLikkutVolume, loadList } from "@/lib/library/mafteiach-fetch";
import { revalidatePath } from "next/cache";
import { fetchPdf } from "@/lib/sources/fetch-pdf";
import { normalizeSourceLink } from "@/lib/sources/link";
import { refreshSie, SIE_WEEKLY_PAGE, type RefreshResult } from "@/lib/library/sie-refresh";
import { sieToRow } from "@printio/shared/library/sie-store";
import { SIE_WEEKLY } from "@printio/shared/library/sie-weekly";
import type { EntrySection, LikkutPage, ListPage } from "@printio/shared/library/mafteiach-parse";
import type { PageRef } from "@printio/shared/library/mafteiach-fetch";
import { enqueueLibraryFetch, getFreshPage, libraryKey, libraryViaServer, onlineFetcherExists } from "@/lib/library/cache";
import { OFFLINE_MESSAGE, PENDING_MESSAGE, type LibraryWaiting } from "@/lib/library/results";

type Failure = { ok: false; message: string };

const WINDOW_SECONDS = 10 * 60;
const MAX_PER_WINDOW = 120;

type Allowed = { ok: true; userId: string; organizationId: string };

/** Same people as the link import and the booklet builder (admins and anyone an admin switched early tools on for). */
async function gate(): Promise<Failure | Allowed> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, message: "Your account is not part of an organization yet." };
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) {
    return { ok: false, message: "The library is being tested with admins first. Ask an admin to switch early tools on for you." };
  }
  const db = createServiceRoleClient();
  const { data: allowed, error } = await db.rpc("check_rate_limit", {
    p_key: `library:user:${session.userId}`,
    p_max_count: MAX_PER_WINDOW,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (!error && allowed === false) return { ok: false, message: "That is a lot of browsing at once. Wait a few minutes and try again." };
  return { ok: true, userId: session.userId, organizationId: session.membership.organization_id };
}

const NOT_ALLOWED = "That library page address is not allowed.";
const FETCH_WINDOW_SECONDS = 10 * 60;
const FETCH_MAX_PER_WINDOW = 30;

/**
 * Switch ON only (LIBRARY_VIA_SERVER): read the shared cache; if the page is there and fresh, hand its payload back; if not,
 * ask a print server to fetch it (one shared job per page) and answer "pending", or answer "offline" when no print server
 * that can fetch is reporting in. Never fetches or parses anything itself.
 */
async function viaServer(who: Allowed, ref: PageRef, isShape: (payload: unknown) => boolean): Promise<{ hit: unknown } | Failure | LibraryWaiting> {
  const key = libraryKey(ref);
  if (!key) return { ok: false, message: NOT_ALLOWED };
  const db = createServiceRoleClient();

  const cached = await getFreshPage(db, key);
  if (cached !== null && isShape(cached)) return { hit: cached };

  if (!(await onlineFetcherExists(db))) return { ok: false, offline: true, message: OFFLINE_MESSAGE };

  const { data: allowed, error } = await db.rpc("check_rate_limit", {
    p_key: `library_fetch:user:${who.userId}`,
    p_max_count: FETCH_MAX_PER_WINDOW,
    p_window_seconds: FETCH_WINDOW_SECONDS,
  });
  if (!error && allowed === false) return { ok: false, message: "That is a lot of browsing at once. Wait a few minutes and try again." };

  const queued = await enqueueLibraryFetch(db, { organizationId: who.organizationId, userId: who.userId, ref });
  switch (queued.kind) {
    case "queued":
    case "active":
      return { ok: false, pending: true, jobId: queued.jobId, message: PENDING_MESSAGE };
    case "recent_failure":
      return { ok: false, message: queued.error || "The print server could not get that page. Try again in a few minutes." };
    case "busy":
      return { ok: false, message: "The library is busy fetching other pages. Try again in a minute." };
    case "invalid":
      return { ok: false, message: NOT_ALLOWED };
    default:
      return { ok: false, message: "Something went wrong on our side. Try again." };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function libraryLikkutAction(volume: number): Promise<{ ok: true; page: LikkutPage } | Failure | LibraryWaiting> {
  const g = await gate();
  if (!g.ok) return g;
  if (!libraryViaServer()) return loadLikkutVolume(volume);
  const got = await viaServer(g, { kind: "likkutei", volume }, (p) => isObj(p) && Array.isArray(p.parshiyos) && Array.isArray(p.volumes));
  return "hit" in got ? { ok: true, page: got.hit as LikkutPage } : got;
}

export async function libraryListAction(section: "maamorim" | "all", year?: string): Promise<{ ok: true; page: ListPage } | Failure | LibraryWaiting> {
  if (section !== "maamorim" && section !== "all") return { ok: false, message: "That part of the library does not exist." };
  const g = await gate();
  if (!g.ok) return g;
  if (!libraryViaServer()) return loadList({ section, year });
  const got = await viaServer(g, year === undefined ? { kind: "list", section } : { kind: "list", section, year }, (p) => isObj(p) && Array.isArray(p.years) && Array.isArray(p.entries));
  return "hit" in got ? { ok: true, page: got.hit as ListPage } : got;
}

export async function libraryEntryAction(path: string): Promise<{ ok: true; sections: EntrySection[] } | Failure | LibraryWaiting> {
  const g = await gate();
  if (!g.ok) return g;
  if (!libraryViaServer()) return loadEntry(String(path));
  const got = await viaServer(g, { kind: "entry", path: String(path) }, Array.isArray);
  return "hit" in got ? { ok: true, sections: got.hit as EntrySection[] } : got;
}

const SIE_PAGE_MAX_BYTES = 3 * 1024 * 1024;
const SIE_FILE_MAX_BYTES = 30 * 1024 * 1024;

/** Sichos In English's weekly page, read from its own fixed address with a size and time limit. */
async function fetchSiePage(): Promise<string> {
  const res = await fetch(SIE_WEEKLY_PAGE, {
    headers: { "user-agent": "Printio/1.0 (library list refresh)", accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (res.url && new URL(res.url).origin !== new URL(SIE_WEEKLY_PAGE).origin) throw new Error("redirected away from the page");
  if (!res.ok) throw new Error(`status ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > SIE_PAGE_MAX_BYTES) throw new Error("page too large");
  return new TextDecoder().decode(bytes);
}

/** A Drive file, through the same safe link import as any pasted link. */
async function fetchSieFile(url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
  const link = normalizeSourceLink(url);
  if (!link.ok) return { ok: false, message: link.message };
  const got = await fetchPdf(link.url, link.kind, { maxBytes: SIE_FILE_MAX_BYTES });
  return got.ok ? { ok: true, bytes: got.bytes } : { ok: false, message: got.message };
}

function describeRefresh(r: RefreshResult): string {
  if (r.added === 0 && r.failed.length === 0) return `No new weeks. The library has all ${r.found} weeks Sichos In English has published.`;
  const parts = [`Added ${r.added} new ${r.added === 1 ? "week" : "weeks"}.`];
  if (r.remaining > 0) parts.push(`${r.remaining} more to add: press the button again.`);
  if (r.failed.length > 0) parts.push(`Could not get: ${r.failed.map((f) => `${f.title} (${f.reason})`).join("; ")}.`);
  return parts.join(" ");
}

/**
 * "Check for new weeks" in the Sichos In English tab. Org admins only. Reads SIE's public weekly page, adds any week the
 * library does not have yet (reading each new file's first and last pages), and stores it so everyone with the library sees it.
 */
export async function refreshSieAction(): Promise<{ ok: boolean; message: string }> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, message: "Your account is not part of an organization yet." };
  if (session.membership.role !== "org_admin") return { ok: false, message: "Only an admin can check for new weeks." };

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `sie_refresh:user:${session.userId}`,
    p_max_count: 6,
    p_window_seconds: 5 * 60,
  });
  if (!limitError && allowed === false) return { ok: false, message: "That is a lot of checking at once. Wait a few minutes and try again." };

  const { data: existing } = await db.from("library_sie_entries").select("url");
  const known = new Set<string>([...SIE_WEEKLY.map((e) => e.url), ...(existing ?? []).map((r) => r.url)]);

  const result = await refreshSie({
    fetchPage: fetchSiePage,
    fetchPdf: fetchSieFile,
    known,
    save: async (rows) => {
      const { error } = await db.from("library_sie_entries").upsert(rows.map((e) => ({ ...sieToRow(e), added_by: session.userId })), { onConflict: "url" });
      if (error) throw new Error(error.message);
    },
  });
  if (result.problem) return { ok: false, message: result.problem };
  if (result.added > 0) revalidatePath("/print/library");
  return { ok: true, message: describeRefresh(result) };
}
