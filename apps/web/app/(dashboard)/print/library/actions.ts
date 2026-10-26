"use server";

import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { canUseLinks } from "@/lib/sources/access";
import { loadEntry, loadLikkutVolume, loadList } from "@/lib/library/mafteiach-fetch";
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
