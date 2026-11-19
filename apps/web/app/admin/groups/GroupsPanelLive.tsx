"use client";

import { GroupsPanel, type GroupsActions } from "./GroupsPanel";
import { addGroupMemberAction, listGroupMembersAction, removeGroupMemberAction, searchGroupCandidatesAction } from "./actions";
import type { GroupSummary } from "@/lib/admin/groups-list";

function form(groupId: string, userId: string): FormData {
  const fd = new FormData();
  fd.set("groupId", groupId);
  fd.set("userId", userId);
  return fd;
}

const ACTIONS: GroupsActions = {
  listMembers: (input) => listGroupMembersAction(input),
  searchCandidates: (input) => searchGroupCandidatesAction(input),
  addMember: (groupId, userId) => addGroupMemberAction({}, form(groupId, userId)),
  removeMember: (groupId, userId) => removeGroupMemberAction({}, form(groupId, userId)),
};

export function GroupsPanelLive({ groups, canManage }: { groups: GroupSummary[]; canManage: boolean }) {
  return <GroupsPanel groups={groups} canManage={canManage} actions={ACTIONS} />;
}
