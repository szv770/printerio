"use client";

import { useActionState } from "react";
import { FolderKanban, FolderPlus, UserMinus } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Badge, Button, Collapsible, EmptyState, Field, FormError, Input, Select } from "@/components/ui";
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

const KIND_LABEL: Record<string, string> = { department: "Department", class: "Class", custom: "Custom" };

export function groupSummary(count: number): string {
  if (count === 0) return "Nobody in it yet";
  return count === 1 ? "1 user" : `${count} users`;
}

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
    <div className="flex flex-col gap-4" data-tour="admin-groups-panel">
      {canManage && (
        <Collapsible
          id="new-group"
          title="New group"
          icon={<FolderPlus className="h-4 w-4" />}
          summary="A department, a class, or any set of people"
          forceOpen={!!createState.error}
        >
          <form action={createAction} className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
            <Field label="Group name" htmlFor="groupName">
              <Input id="groupName" name="name" required placeholder="Science department" />
            </Field>
            <Field label="Type" htmlFor="groupKind">
              <Select id="groupKind" name="kind" defaultValue="custom">
                <option value="department">Department</option>
                <option value="class">Class</option>
                <option value="custom">Custom</option>
              </Select>
            </Field>
            <div className="sm:pt-[1.625rem]">
              <Button type="submit" pending={creating} pendingLabel="Creating..." className="w-full sm:w-auto">
                Create group
              </Button>
            </div>
            <div className="sm:col-span-3">
              <FormError message={createState.error} />
            </div>
          </form>
        </Collapsible>
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
          title="No groups yet"
          message="Groups let you set print rules and monthly limits for a whole department or class at once."
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
  const err = addState.error ?? removeState.error ?? deleteState.error;

  return (
    <Collapsible
      id={`group-${group.id}`}
      title={group.name}
      summary={groupSummary(members.length)}
      badge={<Badge tone={KIND_TONE[group.kind] ?? "neutral"}>{KIND_LABEL[group.kind] ?? group.kind}</Badge>}
      forceOpen={!!err}
    >
      {members.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">Nobody is in this group yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface-2)]/60 py-1 pr-1 pl-3.5 text-sm"
            >
              <span className="min-w-0 truncate">{m.label}</span>
              {canManage && (
                <form action={removeAction}>
                  <input type="hidden" name="groupId" value={group.id} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button
                    type="submit"
                    aria-label={`Take ${m.label} out of ${group.name}`}
                    title="Take out of this group"
                    className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                  >
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && available.length > 0 && (
        <form action={addAction} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="groupId" value={group.id} />
          <div className="min-w-0 flex-1">
            <Field label="Add a user" htmlFor={`addMember-${group.id}`}>
              <Select id={`addMember-${group.id}`} name="userId">
                {available.map((r) => (
                  <option key={r.userId} value={r.userId}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" pending={adding} pendingLabel="Adding..." className="w-full sm:w-auto">
            Add
          </Button>
        </form>
      )}
      <div className="mt-3">
        <FormError message={err} />
      </div>

      {canManage && (
        <form action={deleteAction} className="mt-5 border-t border-[var(--color-border)] pt-4">
          <input type="hidden" name="groupId" value={group.id} />
          <Button type="submit" variant="outline-danger" size="sm" pending={deleting} pendingLabel="Deleting..." className="w-full sm:w-auto">
            Delete this group
          </Button>
        </form>
      )}
    </Collapsible>
  );
}
