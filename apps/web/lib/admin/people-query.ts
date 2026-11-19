/**
 * The People list as DATA: what the admin asked for (search, filters, sort, page), how that is written in the URL,
 * and how it is applied to a database query. No I/O here, so it is unit tested (people-query.test.ts) and the dev
 * preview runs the very same rules over sample people (`runPeopleQuery`).
 *
 * Words: a "section" is where someone works (stored in organization_members.department; the column keeps its
 * old name so nothing in the print path changes). A "group" is a set of people you give rules or limits to.
 *
 * EXTENSION POINTS (docs/ADMIN-USERS-PLAN.md, "Extension points"): everything the list can be filtered by lives in
 * `PeopleFilter`, so a new filter (group, source, "people I manage", last printed) is one field here plus one line
 * in `applyPeopleFilter`; callers (page, bulk bar, export) only ever pass a filter object around.
 */

export const PEOPLE_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PEOPLE_PAGE_SIZE = 50;
export const MAX_SEARCH_LENGTH = 100;
/** Search finds people by name or email through the profiles table first; this caps how many ids that step may return. */
export const SEARCH_PROFILE_ID_CAP = 200;

/** Where a person came from. Phase 1 only ever has "manual"; csv / sync are for later (bulk add, directory sync). */
export type MemberSource = "manual" | "csv" | "sync";

export type PeopleSort = "joined" | "name" | "section" | "role" | "status";
export type SortDir = "asc" | "desc";
export const PEOPLE_SORTS: { value: PeopleSort; label: string }[] = [
  { value: "joined", label: "Date joined" },
  { value: "name", label: "Name" },
  { value: "section", label: "Section" },
  { value: "role", label: "Role" },
  { value: "status", label: "Status" },
];

/** URL value for "people with no section". */
export const NO_SECTION = "__none";
export const ROLE_VALUES = ["student", "staff", "approver", "org_admin"] as const;
export const STATUS_VALUES = ["active", "disabled"] as const;

export interface PeopleFilter {
  /** Free text: name, email, section or print code. */
  q: string;
  role: string | null;
  status: "active" | "disabled" | null;
  /** A section name, or NO_SECTION. */
  section: string | null;
  // Later (each is one more field plus one line in applyPeopleFilter): groupId, source, lastPrinted, managedBy.
}

export interface PeopleQuery {
  filter: PeopleFilter;
  sort: PeopleSort;
  dir: SortDir;
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** One row of the list. Only what the compact row and the bulk bar need; the drawer loads the rest on demand. */
export interface PersonRow {
  userId: string;
  displayName: string | null;
  email: string;
  role: string;
  status: string;
  /** The person's section. */
  department: string | null;
  /** Stored print code, or null while none has been assigned (assigned on first print, or by an admin on demand). */
  userCode: string | null;
  joinedAt: string;
  source?: MemberSource;
}

export interface PeoplePage {
  rows: PersonRow[];
  /** How many people match the filter (not just this page). */
  total: number;
}

export const EMPTY_FILTER: PeopleFilter = { q: "", role: null, status: null, section: null };

export function defaultPeopleQuery(): PeopleQuery {
  return { filter: { ...EMPTY_FILTER }, sort: "joined", dir: "asc", page: 1, pageSize: DEFAULT_PEOPLE_PAGE_SIZE };
}

type RawParams = Record<string, string | string[] | undefined> | URLSearchParams;

function first(params: RawParams, key: string): string {
  const v = params instanceof URLSearchParams ? params.get(key) : params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s : "";
}

/** Clean up what a person typed into the search box: no control characters, trimmed, capped. */
export function cleanSearchText(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH);
}

/** URL params (never trusted) -> a valid query. Unknown values fall back to the default; the page is at least 1. */
export function parsePeopleParams(params: RawParams): PeopleQuery {
  const base = defaultPeopleQuery();
  const role = first(params, "role");
  const status = first(params, "status");
  const section = first(params, "section").trim().slice(0, 80);
  const sort = first(params, "sort");
  const dir = first(params, "dir");
  const page = Number.parseInt(first(params, "page"), 10);
  const size = Number.parseInt(first(params, "size"), 10);
  return {
    filter: {
      q: cleanSearchText(first(params, "q")),
      role: (ROLE_VALUES as readonly string[]).includes(role) ? role : null,
      status: status === "active" || status === "disabled" ? status : null,
      section: section || null,
    },
    sort: PEOPLE_SORTS.some((s) => s.value === sort) ? (sort as PeopleSort) : base.sort,
    dir: dir === "desc" ? "desc" : dir === "asc" ? "asc" : base.dir,
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 100_000) : 1,
    pageSize: (PEOPLE_PAGE_SIZES as readonly number[]).includes(size) ? size : base.pageSize,
  };
}

/** A query -> the URL search string (without "?"). Defaults are left out so URLs stay short and shareable. */
export function peopleQueryToSearch(query: PeopleQuery): string {
  const base = defaultPeopleQuery();
  const p = new URLSearchParams();
  if (query.filter.q) p.set("q", query.filter.q);
  if (query.filter.role) p.set("role", query.filter.role);
  if (query.filter.status) p.set("status", query.filter.status);
  if (query.filter.section) p.set("section", query.filter.section);
  if (query.sort !== base.sort) p.set("sort", query.sort);
  if (query.dir !== base.dir) p.set("dir", query.dir);
  if (query.page > 1) p.set("page", String(query.page));
  if (query.pageSize !== base.pageSize) p.set("size", String(query.pageSize));
  return p.toString();
}

/** True when any filter (not sort or page) is on. */
export function hasActiveFilter(f: PeopleFilter): boolean {
  return !!(f.q || f.role || f.status || f.section);
}

/** How many separate filters are on (the search box counts as one). */
export function activeFilterCount(f: PeopleFilter): number {
  return [f.q, f.role, f.status, f.section].filter(Boolean).length;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The 0-based inclusive row range PostgREST `.range()` wants for this page. */
export function pageRange(page: number, pageSize: number): { from: number; to: number } {
  const from = (Math.max(1, page) - 1) * pageSize;
  return { from, to: from + pageSize - 1 };
}

// --- database filter strings --------------------------------------------------------------------------------------

/** Escapes the three characters that mean something to LIKE / ILIKE, so typed text is matched literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Wraps a value for a PostgREST `.or()` string. Commas, dots, colons and brackets are safe inside the quotes. */
export function quoteForOr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const ID_SAFE = /^[\w-]{1,64}$/;

/**
 * The `.or()` string that searches organization_members for typed text: the section contains it, the print code starts with
 * it, or the person is one of the `profileIds` whose name or email contains it (found in a first step, because a
 * single PostgREST filter cannot reach across both tables). Returns null when there is nothing to search for.
 */
export function buildSearchOr(term: string, profileIds: string[]): string | null {
  const text = cleanSearchText(term);
  if (!text) return null;
  const like = escapeLike(text);
  const parts = [`department.ilike.${quoteForOr(`%${like}%`)}`, `user_code.ilike.${quoteForOr(`${like}%`)}`];
  const ids = profileIds.filter((id) => ID_SAFE.test(id));
  if (ids.length > 0) parts.push(`user_id.in.(${ids.join(",")})`);
  return parts.join(",");
}

/** The `.or()` string for the profiles step: name or email contains the text. */
export function buildProfileSearchOr(term: string): string | null {
  const text = cleanSearchText(term);
  if (!text) return null;
  const pattern = quoteForOr(`%${escapeLike(text)}%`);
  return `email.ilike.${pattern},display_name.ilike.${pattern}`;
}

/** The few query-builder methods the list uses. The real Supabase builder is cast to this at the one call site. */
export interface FilterChain {
  eq(column: string, value: string): FilterChain;
  is(column: string, value: null): FilterChain;
  or(filter: string): FilterChain;
  in(column: string, values: string[]): FilterChain;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): FilterChain;
  range(from: number, to: number): FilterChain;
}

/** Column to order by for each sort. "name" sorts by the person's profile (PostgREST related-column ordering). */
export const SORT_COLUMN: Record<PeopleSort, string> = {
  joined: "created_at",
  name: "profiles(display_name)",
  section: "department",
  role: "role",
  status: "status",
};

/** Applies filter, sort and page to a members query. Always ends with a tie-break on user_id so paging is stable. */
export function applyPeopleQuery<T extends FilterChain>(builder: T, query: PeopleQuery, searchOr: string | null): T {
  let b: FilterChain = builder;
  const f = query.filter;
  if (f.role) b = b.eq("role", f.role);
  if (f.status) b = b.eq("status", f.status);
  if (f.section === NO_SECTION) b = b.is("department", null);
  else if (f.section) b = b.eq("department", f.section);
  if (searchOr) b = b.or(searchOr);
  b = b.order(SORT_COLUMN[query.sort], { ascending: query.dir === "asc", nullsFirst: false }).order("user_id");
  const { from, to } = pageRange(query.page, query.pageSize);
  b = b.range(from, to);
  return b as T;
}

// --- the same rules over an in-memory list (dev preview and tests) -------------------------------------------------

function personName(p: PersonRow): string {
  return (p.displayName ?? p.email).toLowerCase();
}

const SORT_KEY: Record<PeopleSort, (p: PersonRow) => string> = {
  joined: (p) => p.joinedAt,
  name: personName,
  section: (p) => (p.department ?? "").toLowerCase(),
  role: (p) => p.role,
  status: (p) => p.status,
};

/** Filters, sorts and pages an in-memory list with the same meaning as the database query. */
export function runPeopleQuery(all: PersonRow[], query: PeopleQuery): PeopleQuery & PeoplePage {
  const f = query.filter;
  const needle = f.q.toLowerCase();
  const matching = all.filter((p) => {
    if (f.role && p.role !== f.role) return false;
    if (f.status && p.status !== f.status) return false;
    if (f.section === NO_SECTION) {
      if (p.department) return false;
    } else if (f.section && p.department !== f.section) return false;
    if (!needle) return true;
    return (
      (p.displayName ?? "").toLowerCase().includes(needle) ||
      p.email.toLowerCase().includes(needle) ||
      (p.department ?? "").toLowerCase().includes(needle) ||
      (p.userCode ?? "").toLowerCase().startsWith(needle)
    );
  });
  const key = SORT_KEY[query.sort];
  const sign = query.dir === "asc" ? 1 : -1;
  matching.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -sign : sign;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const { from, to } = pageRange(query.page, query.pageSize);
  return { ...query, rows: matching.slice(from, to + 1), total: matching.length };
}
