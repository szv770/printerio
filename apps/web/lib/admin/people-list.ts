/**
 * Reads for the People area, one page at a time. Every query is scoped by `organizationId` (which the caller takes from
 * the signed-in admin's session, never from the URL or the browser) and nothing here ever loads "everyone".
 *
 * Pure rules (filters, sort, URL, search strings) live in people-query.ts; this file only talks to the database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  SEARCH_PROFILE_ID_CAP,
  applyPeopleQuery,
  buildProfileSearchOr,
  buildSearchOr,
  type FilterChain,
  type MemberSource,
  type PeoplePage,
  type PeopleQuery,
  type PersonRow,
} from "./people-query";

type Db = SupabaseClient<Database>;

export interface PeopleFetchResult extends PeoplePage {
  /** More people match the name/email search than the first step looks at; ask the admin to type more. */
  searchTruncated: boolean;
  /** The page asked for is past the last one (the caller sends the admin to the last page). */
  outOfRange: boolean;
  /** Sorting by name was refused by the database, so the list is sorted by date joined instead. */
  sortFellBack: boolean;
}

interface MemberQueryRow {
  user_id: string;
  role: string;
  status: string;
  department: string | null;
  created_at: string;
  user_code: string | null;
  profiles: { email: string; display_name: string | null } | null;
}

const MEMBER_COLUMNS = "user_id, role, status, department, created_at, user_code, profiles(email, display_name)";

export function toPersonRow(r: MemberQueryRow, source: MemberSource = "manual"): PersonRow {
  return {
    userId: r.user_id,
    displayName: r.profiles?.display_name ?? null,
    email: r.profiles?.email ?? "(unknown)",
    role: r.role,
    status: r.status,
    department: r.department,
    userCode: r.user_code,
    joinedAt: r.created_at,
    source,
  };
}

/** Step one of a search: the ids of this organization's people whose name or email contains the text. */
export async function findProfileIdsForSearch(db: Db, organizationId: string, term: string): Promise<{ ids: string[]; truncated: boolean }> {
  const or = buildProfileSearchOr(term);
  if (!or) return { ids: [], truncated: false };
  // The inner embed limits the search to people who are members of THIS organization.
  const { data, error } = await db
    .from("profiles")
    .select("id, organization_members!inner(organization_id)")
    .eq("organization_members.organization_id", organizationId)
    .or(or)
    .limit(SEARCH_PROFILE_ID_CAP + 1);
  if (error) throw new Error(`Couldn't search people: ${error.message}`);
  const ids = (data ?? []).map((r) => r.id);
  return { ids: ids.slice(0, SEARCH_PROFILE_ID_CAP), truncated: ids.length > SEARCH_PROFILE_ID_CAP };
}

/** One page of people plus how many match (exact count, one round trip), for one organization. */
export async function fetchPeoplePage(db: Db, organizationId: string, query: PeopleQuery): Promise<PeopleFetchResult> {
  let searchIds: string[] = [];
  let searchTruncated = false;
  if (query.filter.q) {
    const found = await findProfileIdsForSearch(db, organizationId, query.filter.q);
    searchIds = found.ids;
    searchTruncated = found.truncated;
  }
  const searchOr = buildSearchOr(query.filter.q, searchIds);

  const run = (q: PeopleQuery) => {
    const base = db.from("organization_members").select(MEMBER_COLUMNS, { count: "exact" }).eq("organization_id", organizationId);
    return applyPeopleQuery(base as unknown as FilterChain, q, searchOr) as unknown as typeof base;
  };

  let sortFellBack = false;
  let result = await run(query);
  if (result.error && query.sort === "name") {
    // Ordering by a related column is the one part of this query that was not run against the real database.
    result = await run({ ...query, sort: "joined", dir: "asc" });
    sortFellBack = !result.error;
  }
  if (result.error && query.page > 1) {
    const first = await run({ ...query, page: 1 });
    if (first.error) throw new Error(`Couldn't load people: ${first.error.message}`);
    return { rows: [], total: first.count ?? 0, searchTruncated, outOfRange: true, sortFellBack };
  }
  if (result.error) throw new Error(`Couldn't load people: ${result.error.message}`);
  const rows = ((result.data ?? []) as unknown as MemberQueryRow[]).map((r) => toPersonRow(r));
  return { rows, total: result.count ?? rows.length, searchTruncated, outOfRange: false, sortFellBack };
}

/** Rows read at a time when walking a column (PostgREST answers at most 1,000 per request on Supabase). */
const WALK_CHUNK = 1000;
/** Never walk more than this many rows of one organization for a pick-list (a safety stop, far above 5,000 people). */
const WALK_MAX_ROWS = 20_000;

/** Distinct, trimmed, non-empty values sorted A to Z ignoring case. Exact text is kept because print rules match it exactly. */
export function distinctSections(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    const t = (v ?? "").trim();
    if (t) seen.add(t);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : 1));
}

/** The sections already in use in this organization (the pick-list). Read in parallel chunks, only when a list is opened. */
export async function fetchSections(db: Db, organizationId: string): Promise<string[]> {
  const { count, error: countError } = await db
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .not("department", "is", null);
  if (countError) throw new Error(`Couldn't read sections: ${countError.message}`);
  const total = Math.min(count ?? 0, WALK_MAX_ROWS);
  const chunks = Math.ceil(total / WALK_CHUNK);
  const pages = await Promise.all(
    Array.from({ length: chunks }, async (_, i) => {
      const { data, error } = await db
        .from("organization_members")
        .select("department")
        .eq("organization_id", organizationId)
        .not("department", "is", null)
        .order("user_id")
        .range(i * WALK_CHUNK, (i + 1) * WALK_CHUNK - 1);
      if (error) throw new Error(`Couldn't read sections: ${error.message}`);
      return (data ?? []).map((r) => r.department);
    }),
  );
  return distinctSections(pages.flat());
}

/** How many people in this organization have no stored print code yet (cheap head count). */
export async function countMembersWithoutCode(db: Db, organizationId: string): Promise<number> {
  const { count } = await db
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .is("user_code", null);
  return count ?? 0;
}
