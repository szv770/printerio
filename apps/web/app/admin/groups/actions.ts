"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";

export interface GroupActionState {
  error?: string;
}

const VALID_KINDS = ["department", "class", "custom"];

export async function createGroupAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "custom");
  if (!name) return { error: "Name is required." };
  if (!VALID_KINDS.includes(kind)) return { error: "Invalid kind." };

  const supabase = await createClient();
  const { error } = await supabase.from("groups").insert({
    organization_id: session.membership.organization_id,
    name,
    kind,
  });
  if (error) {
    return {
      error: error.code === "23505" ? "A group with that name already exists." : describeDatabaseError(error, "Couldn't create that group."),
    };
  }

  revalidatePath(routes.adminGroups);
  return {};
}

export async function deleteGroupAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const groupId = String(formData.get("groupId") ?? "");

  const supabase = await createClient();
  const { error } = await supabase
    .from("groups")
    .delete()
    .eq("id", groupId)
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't delete that group.") };

  revalidatePath(routes.adminGroups);
  return {};
}

async function assertGroupInOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  groupId: string,
  organizationId: string,
): Promise<boolean> {
  const { data } = await supabase.from("groups").select("organization_id").eq("id", groupId).maybeSingle();
  return data?.organization_id === organizationId;
}

export async function addGroupMemberAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const groupId = String(formData.get("groupId") ?? "");
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Choose a member to add." };

  const supabase = await createClient();
  if (!(await assertGroupInOrg(supabase, groupId, session.membership.organization_id))) {
    return { error: "Group not found." };
  }

  const { error } = await supabase.from("group_members").insert({ group_id: groupId, user_id: userId });
  if (error) {
    return {
      error: error.code === "23505" ? "Already a member of this group." : describeDatabaseError(error, "Couldn't add that member to the group."),
    };
  }

  revalidatePath(routes.adminGroups);
  return {};
}

export async function removeGroupMemberAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const groupId = String(formData.get("groupId") ?? "");
  const userId = String(formData.get("userId") ?? "");

  const supabase = await createClient();
  if (!(await assertGroupInOrg(supabase, groupId, session.membership.organization_id))) {
    return { error: "Group not found." };
  }

  const { error } = await supabase.from("group_members").delete().eq("group_id", groupId).eq("user_id", userId);
  if (error) return { error: describeDatabaseError(error, "Couldn't remove that member from the group.") };

  revalidatePath(routes.adminGroups);
  return {};
}
