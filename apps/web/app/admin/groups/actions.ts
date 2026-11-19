"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { cleanSearchText } from "@/lib/admin/people-query";
import { fetchGroupMembersPage, groupBelongsToOrg, searchGroupCandidates, type GroupMemberRow, type GroupMembersPage } from "@/lib/admin/groups-list";
import { logger } from "@/lib/logger";

export interface GroupActionState {
  error?: string;
}

const VALID_KINDS = ["department", "class", "custom"];
const ID_SAFE = /^[\w-]{1,64}$/;

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function audit(supabase: Supabase, session: { userId: string; membership: { organization_id: string } }, action: string, groupId: string | null, metadata: Record<string, string | number | null>) {
  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action,
    target_type: "groups",
    target_id: groupId,
    metadata,
  });
}

export async function createGroupAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "custom");
  if (!name) return { error: "Name is required." };
  if (!VALID_KINDS.includes(kind)) return { error: "Invalid kind." };

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("groups")
    .insert({
      organization_id: session.membership.organization_id,
      name,
      kind,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    return {
      error: error.code === "23505" ? "A group with that name already exists." : describeDatabaseError(error, "Couldn't create that group."),
    };
  }
  await audit(supabase, session, "group.created", created?.id ?? null, { name, kind });

  revalidatePath(routes.adminGroups);
  return {};
}

export async function deleteGroupAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const groupId = String(formData.get("groupId") ?? "");

  const supabase = await createClient();
  const { data: group } = await supabase.from("groups").select("name").eq("id", groupId).eq("organization_id", session.membership.organization_id).maybeSingle();
  const { error } = await supabase
    .from("groups")
    .delete()
    .eq("id", groupId)
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't delete that group.") };
  if (group) await audit(supabase, session, "group.deleted", groupId, { name: group.name });

  revalidatePath(routes.adminGroups);
  return {};
}

export async function addGroupMemberAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const groupId = String(formData.get("groupId") ?? "");
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Choose a member to add." };

  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  if (!(await groupBelongsToOrg(supabase, groupId, orgId))) {
    return { error: "Group not found." };
  }
  // The person must be a member of THIS organization (the id comes from the browser).
  const { data: person } = await supabase.from("organization_members").select("user_id").eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  if (!person) return { error: "That person is not in this organization." };

  const { error } = await supabase.from("group_members").insert({ group_id: groupId, user_id: userId });
  if (error) {
    return {
      error: error.code === "23505" ? "Already a member of this group." : describeDatabaseError(error, "Couldn't add that member to the group."),
    };
  }
  await audit(supabase, session, "group.member_added", groupId, { user_id: userId });

  revalidatePath(routes.adminGroups);
  return {};
}

export async function removeGroupMemberAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const groupId = String(formData.get("groupId") ?? "");
  const userId = String(formData.get("userId") ?? "");

  const supabase = await createClient();
  if (!(await groupBelongsToOrg(supabase, groupId, session.membership.organization_id))) {
    return { error: "Group not found." };
  }

  const { error } = await supabase.from("group_members").delete().eq("group_id", groupId).eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't remove that member from the group.") };
  await audit(supabase, session, "group.member_removed", groupId, { user_id: userId });

  revalidatePath(routes.adminGroups);
  return {};
}

/** One page of a group's members (admins and approvers can look; the group must be in their organization). */
export async function listGroupMembersAction(input: { groupId: string; q?: string; page?: number }): Promise<GroupMembersPage | null> {
  const session = await requireOrgRole(["org_admin", "approver"]);
  if (!ID_SAFE.test(String(input?.groupId ?? ""))) return null;
  const supabase = await createClient();
  if (!(await groupBelongsToOrg(supabase, input.groupId, session.membership.organization_id))) return null;
  try {
    return await fetchGroupMembersPage(supabase, input.groupId, { q: cleanSearchText(String(input.q ?? "")), page: Number(input.page) || 1 });
  } catch (err) {
    logger.error("could not list group members", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Type-ahead for "add someone to this group" (admin only, like adding). */
export async function searchGroupCandidatesAction(input: { groupId: string; q: string }): Promise<GroupMemberRow[]> {
  const session = await requireOrgRole(["org_admin"]);
  if (!ID_SAFE.test(String(input?.groupId ?? ""))) return [];
  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  if (!(await groupBelongsToOrg(supabase, input.groupId, orgId))) return [];
  try {
    return await searchGroupCandidates(supabase, orgId, input.groupId, String(input.q ?? ""));
  } catch (err) {
    logger.error("could not search people for a group", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
