"use client";

import { useActionState } from "react";
import { FolderKanban } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, Select, FieldLabel, FormError, Badge, EmptyState, Card } from "@/components/ui";
import {
  createGroupAction,
  deleteGroupAction,
  addGroupMemberAction,
  removeGroupMemberAction,
  type GroupActionState,
} from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialGroupActionState: GroupActionState = {};

type Group = Tables<"groups">;
interface GroupMember {
  group_id: string;
  user_id: string;
}
interface RosterEntry {
  userId: string;
  label: string;
}

const KIND_TONE: Record<string, "neutral" | "success" | "warning"> = {
  department: "success",
  class: "warning",
  custom: "neutral",
};

export function GroupsPanel({
  groups,
  groupMembers,
  roster,
  canManage,
}: {
  groups: Group[];
  groupMembers: GroupMember[];
  roster: RosterEntry[];
  canManage: boolean;
}) {
  const [createState, createAction, creating] = useActionState(createGroupAction, initialGroupActionState);

  return (
    <div className="flex flex-col gap-6" data-tour="admin-groups-panel">
      {canManage && (
        <Card>
          <form action={createAction} className="flex items-end gap-3">
            <div>
              <FieldLabel htmlFor="groupName">New group name</FieldLabel>
              <Input id="groupName" name="name" required placeholder="Science Department" />
            </div>
            <div>
              <FieldLabel htmlFor="groupKind">Kind</FieldLabel>
              <Select id="groupKind" name="kind" defaultValue="custom">
                <option value="department">Department</option>
                <option value="class">Class</option>
                <option value="custom">Custom</option>
              </Select>
            </div>
            <Button type="submit" size="sm" pending={creating} pendingLabel="Creating...">
              Create group
            </Button>
            <FormError message={createState.error} />
          </form>
        </Card>
      )}

      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          memberIds={groupMembers.filter((gm) => gm.group_id === group.id).map((gm) => gm.user_id)}
          roster={roster}
          canManage={canManage}
        />
      ))}
      {groups.length === 0 && (
        <EmptyState
          message="No groups yet - groups let policies and quotas scope to a department, class, or custom cohort."
          icon={FolderKanban}
        />
      )}
    </div>
  );
}

function GroupCard({
  group,
  memberIds,
  roster,
  canManage,
}: {
  group: Group;
  memberIds: string[];
  roster: RosterEntry[];
  canManage: boolean;
}) {
  const [addState, addAction, adding] = useActionState(addGroupMemberAction, initialGroupActionState);
  const [removeState, removeAction] = useActionState(removeGroupMemberAction, initialGroupActionState);
  const [deleteState, deleteAction, deleting] = useActionState(deleteGroupAction, initialGroupActionState);

  const memberSet = new Set(memberIds);
  const members = roster.filter((r) => memberSet.has(r.userId));
  const available = roster.filter((r) => !memberSet.has(r.userId));

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="font-medium">{group.name}</p>
          <Badge tone={KIND_TONE[group.kind] ?? "neutral"}>{group.kind}</Badge>
        </div>
        {canManage && (
          <form action={deleteAction}>
            <input type="hidden" name="groupId" value={group.id} />
            <Button type="submit" variant="outline-danger" size="sm" pending={deleting} pendingLabel="Deleting...">
              Delete group
            </Button>
          </form>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
            <span>{m.label}</span>
            {canManage && (
              <form action={removeAction}>
                <input type="hidden" name="groupId" value={group.id} />
                <input type="hidden" name="userId" value={m.userId} />
                <button type="submit" className="text-xs text-[var(--color-muted)] underline">
                  remove
                </button>
              </form>
            )}
          </li>
        ))}
        {members.length === 0 && <p className="text-xs text-[var(--color-muted)]">No members in this group.</p>}
      </ul>
      <FormError message={removeState.error} />

      {canManage && available.length > 0 && (
        <form action={addAction} className="mt-3 flex items-end gap-2">
          <input type="hidden" name="groupId" value={group.id} />
          <div>
            <FieldLabel htmlFor={`addMember-${group.id}`}>Add member</FieldLabel>
            <Select id={`addMember-${group.id}`} name="userId" className="w-auto">
              {available.map((r) => (
                <option key={r.userId} value={r.userId}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" size="sm" pending={adding} pendingLabel="Adding...">
            Add
          </Button>
        </form>
      )}
      <FormError message={addState.error} />
      <FormError message={deleteState.error} />
    </Card>
  );
}
