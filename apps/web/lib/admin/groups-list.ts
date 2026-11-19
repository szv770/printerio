/**
 * Reads for the Groups page. A group card shows a COUNT; its members are only fetched (a page at a time, searchable) when the
 * card is opened, and the "add someone" box searches on the server (type-ahead, 20 results). Nothing here loads a whole roster.
 * Every query takes `organizationId` from the signed-in admin's session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { buildProfileSearchOr, cleanSearchText } from "./people-query";

type Db = SupabaseClient<Database>;

export const GROUP_MEMBERS_PAGE_SIZE = 25;
export const GROUP_CANDIDATE_LIMIT = 20;
export const GROUP_SEARCH_MIN_CHARS = 2;
const GROUP_LIST_LIMIT = 500;

export interface GroupSummary {
  id: string;
  name: string;
  kind: string;
  memberCount: number;
}

export interface GroupMemberRow {
  userId: string;
  name: string | null;
  email: string;
}

export interface GroupMembersPage {
  rows: GroupMemberRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** The organization's groups with how many people are in each, in one query (the count is computed by the database). */
export async function fetchGroupSummaries(db: Db, organizationId: string): Promise<GroupSummary[]> {
  const { data, error } = await db
    .from("groups")
    .select("id, name, kind, group_members(count)")
    .eq("organization_id", organizationId)
    .order("name")
    .limit(GROUP_LIST_LIMIT);
  if (error) throw new Error(`Couldn't load groups: ${error.message}`);
  return (data ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    memberCount: (g.group_members as unknown as Array<{ count: number }> | null)?.[0]?.count ?? 0,
  }));
}

/** True when the group belongs to this organization. Every group read or write goes through this first. */
export async function groupBelongsToOrg(db: Db, groupId: string, organizationId: string): Promise<boolean> {
  const { data } = await db.from("groups").select("organization_id").eq("id", groupId).maybeSingle();
  return data?.organization_id === organizationId;
}

/** One page of a group's members, optionally narrowed by name or email. The caller has checked the group is in the organization. */
export async function fetchGroupMembersPage(db: Db, groupId: string, input: { q: string; page: number; pageSize?: number }): Promise<GroupMembersPage> {
  const pageSize = input.pageSize ?? GROUP_MEMBERS_PAGE_SIZE;
  const page = Math.max(1, Math.floor(input.page) || 1);
  const search = buildProfileSearchOr(input.q);
  const run = (byName: boolean) => {
    let q = db
      .from("group_members")
      .select("user_id, profiles!inner(email, display_name)", { count: "exact" })
      .eq("group_id", groupId);
    if (search) q = q.or(search, { referencedTable: "profiles" });
    q = byName ? q.order("profiles(display_name)", { ascending: true, nullsFirst: false }) : q;
    return q.order("user_id").range((page - 1) * pageSize, page * pageSize - 1);
  };
  let res = await run(true);
  // Ordering by the person's name uses a related column that has not been run against the real database; fall back to id order.
  if (res.error) res = await run(false);
  if (res.error) {
    if (page > 1) return { rows: [], total: 0, page: 1, pageSize };
    throw new Error(`Couldn't load the group's members: ${res.error.message}`);
  }
  const rows = ((res.data ?? []) as unknown as Array<{ user_id: string; profiles: { email: string; display_name: string | null } | null }>).map((r) => ({
    userId: r.user_id,
    name: r.profiles?.display_name ?? null,
    email: r.profiles?.email ?? "(unknown)",
  }));
  return { rows, total: res.count ?? rows.length, page, pageSize };
}

/** Type-ahead for "add someone": up to 20 people of this organization matching the text who are not already in the group. */
export async function searchGroupCandidates(db: Db, organizationId: string, groupId: string, text: string): Promise<GroupMemberRow[]> {
  const term = cleanSearchText(text);
  const or = buildProfileSearchOr(term);
  if (term.length < GROUP_SEARCH_MIN_CHARS || !or) return [];
  const { data, error } = await db
    .from("organization_members")
    .select("user_id, profiles!inner(email, display_name)")
    .eq("organization_id", organizationId)
    .or(or, { referencedTable: "profiles" })
    .order("user_id")
    .limit(GROUP_CANDIDATE_LIMIT * 2);
  if (error) throw new Error(`Couldn't search people: ${error.message}`);
  const found = (data ?? []) as unknown as Array<{ user_id: string; profiles: { email: string; display_name: string | null } | null }>;
  if (found.length === 0) return [];
  const { data: already } = await db
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .in("user_id", found.map((f) => f.user_id));
  const taken = new Set((already ?? []).map((r) => r.user_id));
  return found
    .filter((f) => !taken.has(f.user_id))
    .slice(0, GROUP_CANDIDATE_LIMIT)
    .map((f) => ({ userId: f.user_id, name: f.profiles?.display_name ?? null, email: f.profiles?.email ?? "(unknown)" }));
}

/** Takes people out of every group of this organization (used when they are removed from it, so no ghost members are left behind). */
export async function removeFromOrgGroups(db: Db, organizationId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const { data: groups } = await db.from("groups").select("id").eq("organization_id", organizationId).limit(GROUP_LIST_LIMIT);
  const groupIds = (groups ?? []).map((g) => g.id);
  if (groupIds.length === 0) return;
  await db.from("group_members").delete().in("group_id", groupIds).in("user_id", userIds);
}
