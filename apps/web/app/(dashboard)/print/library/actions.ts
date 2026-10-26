"use server";

import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { canUseLinks } from "@/lib/sources/access";
import { loadEntry, loadLikkutVolume, loadList } from "@/lib/library/mafteiach-fetch";
import { revalidatePath } from "next/cache";
import { fetchPdf } from "@/lib/sources/fetch-pdf";
import { normalizeSourceLink } from "@/lib/sources/link";
import { refreshSie, SIE_WEEKLY_PAGE, type RefreshResult } from "@/lib/library/sie-refresh";
import { sieToRow } from "@/lib/library/sie-store";
import { SIE_WEEKLY } from "@/lib/library/sie-weekly";
import type { EntrySection, LikkutPage, ListPage } from "@/lib/library/mafteiach-parse";

type Failure = { ok: false; message: string };

const WINDOW_SECONDS = 10 * 60;
const MAX_PER_WINDOW = 120;

/** Same people as the link import and the booklet builder (admins and anyone an admin switched early tools on for). */
async function gate(): Promise<Failure | null> {
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
  return null;
}

export async function libraryLikkutAction(volume: number): Promise<{ ok: true; page: LikkutPage } | Failure> {
  return (await gate()) ?? (await loadLikkutVolume(volume));
}

export async function libraryListAction(section: "maamorim" | "all", year?: string): Promise<{ ok: true; page: ListPage } | Failure> {
  if (section !== "maamorim" && section !== "all") return { ok: false, message: "That part of the library does not exist." };
  return (await gate()) ?? (await loadList({ section, year }));
}

export async function libraryEntryAction(path: string): Promise<{ ok: true; sections: EntrySection[] } | Failure> {
  return (await gate()) ?? (await loadEntry(String(path)));
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
