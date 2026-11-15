import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { libraryPageUrl, type PageRef } from "@printio/shared/library/mafteiach-fetch";

/**
 * The library's shared page cache and the "please fetch this page" queue (docs/PHASE-C-PLAN.md, C1b). Everything here takes
 * the database client as an argument and does no network or HTML work: a print server fetches and parses, the website only
 * reads the cache and queues requests. Nothing in this file accepts, builds or returns a web address; pages are named by a
 * key built from the few allowed shapes in `@printio/shared/library/mafteiach-fetch`.
 */

type Db = SupabaseClient<Database>;

/**
 * THE SWITCH. `LIBRARY_VIA_SERVER=1` (or `true`) makes the library browser read the shared cache and ask a print server to
 * fetch what is missing. Unset, or anything else, means OFF: the browser fetches live, exactly as it always did. Read at
 * call time; changing it needs a website restart because it is an environment variable.
 */
export function libraryViaServer(): boolean {
  const v = (process.env.LIBRARY_VIA_SERVER ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** How long a cached page is served: lists and Likkutei Sichos volumes change slowly (a day), single entries even less (a week). */
export const LIST_TTL_MS = 24 * 3600_000;
export const ENTRY_TTL_MS = 7 * 24 * 3600_000;
/** An entry that came back with no sections at all (not published yet, or a hiccup) is kept this briefly, so it is looked at again soon. */
export const EMPTY_ENTRY_TTL_MS = 10 * 60_000;
/** A failed job for a page is shown again, not retried, for this long (the source may be having a bad minute; do not hammer it). */
export const FAILED_RETRY_MS = 5 * 60_000;
/** A print server counts as online when it reported in (heartbeat) this recently. The agent's heartbeat is every 30 s (at most every 120 s by configuration), so this stays well above that. */
export const FETCHER_ONLINE_MS = 5 * 60_000;
/** The most jobs allowed to wait in the queue at once (a stampede brake). */
export const MAX_QUEUED_JOBS = 50;

/**
 * The page a request names, rebuilt from ONLY its validated fields, or null. Accepts anything (a job's stored params, a
 * client's argument): wrong types, extra fields and addresses that are not one of the allowed shapes all give null.
 */
export function parseLibraryRef(input: unknown): PageRef | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  let ref: PageRef | null = null;
  if (r.kind === "likkutei") {
    if (typeof r.volume === "number") ref = { kind: "likkutei", volume: r.volume };
  } else if (r.kind === "list") {
    if (r.section === "maamorim" || r.section === "all") {
      if (r.year === undefined) ref = { kind: "list", section: r.section };
      else if (typeof r.year === "string") ref = { kind: "list", section: r.section, year: r.year };
    }
  } else if (r.kind === "entry") {
    if (typeof r.path === "string") ref = { kind: "entry", path: r.path };
  }
  // The shared builder is the one judge of the allowed shapes.
  return ref && libraryPageUrl(ref) !== null ? ref : null;
}

/** The cache key for a page: `likkutei:12`, `list:maamorim:5710`, `list:all:current`, `entry:/maamorim/123`. Null when not an allowed shape. */
export function libraryKey(ref: PageRef | unknown): string | null {
  const p = parseLibraryRef(ref);
  if (!p) return null;
  if (p.kind === "likkutei") return `likkutei:${p.volume}`;
  if (p.kind === "list") return `list:${p.section}:${p.year ?? "current"}`;
  return `entry:${p.path}`;
}

/** How long to keep a page. Pass the payload to give an entry with zero sections the short empty-entry lifetime (it is still accepted and stored). */
export function libraryTtlMs(ref: PageRef, payload?: unknown): number {
  if (ref.kind !== "entry") return LIST_TTL_MS;
  return Array.isArray(payload) && payload.length === 0 ? EMPTY_ENTRY_TTL_MS : ENTRY_TTL_MS;
}

/** The cache row's `kind` column. */
export function libraryKind(ref: PageRef): "likkutei" | "list" | "entry" {
  return ref.kind;
}

/** The cached payload for a key if it has not expired, else null (also null when the read fails: the caller then asks for a fetch). */
export async function getFreshPage(db: Db, key: string): Promise<unknown | null> {
  const { data, error } = await db
    .from("library_pages")
    .select("payload")
    .eq("key", key)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  return data.payload;
}

export type EnqueueOutcome =
  | { kind: "queued"; jobId: string }
  | { kind: "active"; jobId: string }
  | { kind: "recent_failure"; jobId: string; error: string }
  | { kind: "busy" }
  | { kind: "invalid" }
  | { kind: "error" };

async function activeJob(db: Db, key: string): Promise<string | null> {
  const { data } = await db.from("server_jobs").select("id").eq("dedupe_key", key).in("status", ["queued", "claimed"]).maybeSingle();
  return data?.id ?? null;
}

/**
 * Asks for a page to be fetched. One active job per page (the unique index is the real guard; the lookups here just give a
 * friendly answer): an active job is returned instead of a second one; a job for the page that FAILED less than 5 minutes ago
 * is returned with its error instead of trying again; and no new job is made while the queue is full.
 */
export async function enqueueLibraryFetch(db: Db, args: { organizationId: string; userId: string; ref: PageRef }): Promise<EnqueueOutcome> {
  const ref = parseLibraryRef(args.ref);
  const key = ref ? libraryKey(ref) : null;
  if (!ref || !key) return { kind: "invalid" };

  const existing = await activeJob(db, key);
  if (existing) return { kind: "active", jobId: existing };

  const since = new Date(Date.now() - FAILED_RETRY_MS).toISOString();
  const { data: failed } = await db
    .from("server_jobs")
    .select("id, error")
    .eq("dedupe_key", key)
    .eq("status", "failed")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (failed) return { kind: "recent_failure", jobId: failed.id, error: failed.error ?? "" };

  const { count } = await db.from("server_jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
  if ((count ?? 0) >= MAX_QUEUED_JOBS) return { kind: "busy" };

  const { data: inserted, error } = await db
    .from("server_jobs")
    .insert({
      kind: "library_fetch",
      organization_id: args.organizationId,
      requested_by: args.userId,
      // Structured and rebuilt from the validated fields: never a URL, never anything the caller added.
      params: ref as unknown as Database["public"]["Tables"]["server_jobs"]["Insert"]["params"],
      dedupe_key: key,
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    // Someone else queued the same page a moment ago (the unique index refused ours): share their job.
    const winner = await activeJob(db, key);
    return winner ? { kind: "active", jobId: winner } : { kind: "error" };
  }
  if (error || !inserted) return { kind: "error" };
  return { kind: "queued", jobId: inserted.id };
}

/** True when a print server registered in `library_fetchers` reported in within the last 5 minutes (agents.last_seen_at is the heartbeat). */
export async function onlineFetcherExists(db: Db): Promise<boolean> {
  const { data: fetchers, error } = await db.from("library_fetchers").select("agent_id");
  if (error || !fetchers || fetchers.length === 0) return false;
  const since = new Date(Date.now() - FETCHER_ONLINE_MS).toISOString();
  const { data: online, error: agentError } = await db
    .from("agents")
    .select("id")
    .in("id", fetchers.map((f) => f.agent_id))
    .eq("status", "active")
    .gte("last_seen_at", since)
    .limit(1);
  return !agentError && !!online && online.length > 0;
}
