"use client";

import { useActionState, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, FolderKanban, FolderPlus, Search, UserMinus, UserPlus } from "lucide-react";
import { Badge, Button, Collapsible, EmptyState, Field, FormError, Input, Select } from "@/components/ui";
import { GROUP_SEARCH_MIN_CHARS, type GroupMemberRow, type GroupMembersPage, type GroupSummary } from "@/lib/admin/groups-list";
import { createGroupAction, deleteGroupAction, type GroupActionState } from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialGroupActionState: GroupActionState = {};

/** What the cards need from the server. The real page passes the server actions; the dev preview passes in-memory stand-ins. */
export interface GroupsActions {
  listMembers: (input: { groupId: string; q: string; page: number }) => Promise<GroupMembersPage | null>;
  searchCandidates: (input: { groupId: string; q: string }) => Promise<GroupMemberRow[]>;
  addMember: (groupId: string, userId: string) => Promise<{ error?: string }>;
  removeMember: (groupId: string, userId: string) => Promise<{ error?: string }>;
}

const KIND_TONE: Record<string, "neutral" | "success" | "warning"> = {
  department: "success",
  class: "warning",
  custom: "neutral",
};

const KIND_LABEL: Record<string, string> = { department: "Department", class: "Class", custom: "Custom" };

export function groupSummary(count: number): string {
  if (count === 0) return "Nobody in it yet";
  return count === 1 ? "1 user" : `${count.toLocaleString("en-US")} users`;
}

/** The name filter for the group list itself (a few hundred names at most, so it is done in the browser). */
export function filterGroups<T extends { name: string }>(groups: T[], text: string): T[] {
  const q = text.trim().toLowerCase();
  return q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
}

export function GroupsPanel({ groups, canManage, actions, readOnlyPreview = false }: { groups: GroupSummary[]; canManage: boolean; actions: GroupsActions; readOnlyPreview?: boolean }) {
  const [createState, createAction, creating] = useActionState(createGroupAction, initialGroupActionState);
  const [filter, setFilter] = useState("");
  const shown = filterGroups(groups, filter);

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
            <fieldset disabled={readOnlyPreview} className="contents">
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
            </fieldset>
            <div className="sm:col-span-3">
              <FormError message={createState.error} />
            </div>
          </form>
        </Collapsible>
      )}

      {groups.length > 6 && (
        <label className="relative">
          <span className="sr-only">Find a group</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[var(--color-faint)]" aria-hidden="true" />
          <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find a group (${groups.length.toLocaleString("en-US")})`} className="pl-10" />
        </label>
      )}

      {shown.map((group) => (
        <GroupCard key={group.id} group={group} canManage={canManage} actions={actions} readOnlyPreview={readOnlyPreview} />
      ))}
      {groups.length > 0 && shown.length === 0 && <EmptyState message="No group has that name." icon={Search} />}
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

function GroupCard({ group, canManage, actions, readOnlyPreview }: { group: GroupSummary; canManage: boolean; actions: GroupsActions; readOnlyPreview: boolean }) {
  const [deleteState, deleteAction, deleting] = useActionState(deleteGroupAction, initialGroupActionState);
  const [opened, setOpened] = useState(false);
  // The count shown follows the server's number, and moves by one as soon as someone is added or removed here.
  const [count, setCount] = useState({ base: group.memberCount, n: group.memberCount });
  if (count.base !== group.memberCount) setCount({ base: group.memberCount, n: group.memberCount });

  return (
    <Collapsible
      id={`group-${group.id}`}
      title={group.name}
      summary={groupSummary(count.n)}
      badge={<Badge tone={KIND_TONE[group.kind] ?? "neutral"}>{KIND_LABEL[group.kind] ?? group.kind}</Badge>}
      forceOpen={!!deleteState.error}
      onOpenChange={(o) => o && setOpened(true)}
    >
      {opened && <GroupMembers groupId={group.id} groupName={group.name} canManage={canManage} actions={actions} onCount={(d) => setCount((c) => ({ ...c, n: Math.max(0, c.n + d) }))} />}

      <div className="mt-3">
        <FormError message={deleteState.error} />
      </div>

      {canManage && (
        <form action={deleteAction} className="mt-5 border-t border-[var(--color-border)] pt-4">
          <input type="hidden" name="groupId" value={group.id} />
          <Button type="submit" variant="outline-danger" size="sm" disabled={readOnlyPreview} pending={deleting} pendingLabel="Deleting..." className="w-full sm:w-auto">
            Delete this group
          </Button>
        </form>
      )}
    </Collapsible>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function GroupMembers({ groupId, groupName, canManage, actions, onCount }: { groupId: string; groupName: string; canManage: boolean; actions: GroupsActions; onCount: (delta: number) => void }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<GroupMembersPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [prevQ, setPrevQ] = useState(q);
  if (prevQ !== q) {
    setPrevQ(q);
    setPage(1);
  }

  useEffect(() => {
    let cancelled = false;
    actions
      .listMembers({ groupId, q, page })
      .then((res) => {
        if (cancelled) return;
        setFailed(res === null);
        if (res) setData(res);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [actions, groupId, q, page, version]);

  async function remove(m: GroupMemberRow) {
    setError(null);
    const res = await actions.removeMember(groupId, m.userId).catch(() => ({ error: "Couldn't remove them. Try again." }));
    if (res.error) setError(res.error);
    else {
      onCount(-1);
      setVersion((v) => v + 1);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div>
      <label className="relative block">
        <span className="sr-only">Search people in {groupName}</span>
        <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[var(--color-faint)]" aria-hidden="true" />
        <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search this group" className="pl-10" maxLength={100} />
      </label>

      <div className="mt-3" aria-live="polite">
        {failed ? (
          <FormError message="Couldn't load this group's people. Close it and open it again." />
        ) : !data ? (
          <p className="text-sm text-[var(--color-muted)]">Loading...</p>
        ) : data.rows.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{q ? "Nobody in this group matches that." : "Nobody is in this group yet."}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.rows.map((m) => {
              const label = m.name ?? m.email;
              return (
                <li key={m.userId} className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface-2)]/60 py-1 pr-1 pl-3.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{label}</span>
                    {m.name && <span className="block truncate text-[13px] text-[var(--color-muted)]">{m.email}</span>}
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => void remove(m)}
                      aria-label={`Take ${label} out of ${groupName}`}
                      title="Take out of this group"
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                    >
                      <UserMinus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {data && data.total > data.pageSize && (
        <nav aria-label={`${groupName} pages`} className="mt-3 flex items-center justify-between text-sm">
          <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Prev
          </Button>
          <span className="text-[var(--color-muted)]">
            Page {page} of {pages.toLocaleString("en-US")} · {data.total.toLocaleString("en-US")} people
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label="Next page">
            Next
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </nav>
      )}

      {canManage && (
        <AddPerson
          groupId={groupId}
          groupName={groupName}
          actions={actions}
          onAdded={() => {
            onCount(1);
            setVersion((v) => v + 1);
          }}
        />
      )}
      <div className="mt-3">
        <FormError message={error} />
      </div>
    </div>
  );
}

/** Type two letters, pick from up to 20 matches found on the server. */
function AddPerson({ groupId, groupName, actions, onAdded }: { groupId: string; groupName: string; actions: GroupsActions; onAdded: () => void }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  // Results remember which text they answer, so "still searching" is simply "the answer is for older text".
  const [answer, setAnswer] = useState<{ q: string; rows: GroupMemberRow[] }>({ q: "", rows: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.length < GROUP_SEARCH_MIN_CHARS) return;
    let cancelled = false;
    actions
      .searchCandidates({ groupId, q })
      .then((rows) => !cancelled && setAnswer({ q, rows }))
      .catch(() => !cancelled && setAnswer({ q, rows: [] }));
    return () => {
      cancelled = true;
    };
  }, [actions, groupId, q]);
  const results = answer.rows;
  const searching = answer.q !== q;

  async function add(m: GroupMemberRow) {
    setError(null);
    const res = await actions.addMember(groupId, m.userId).catch(() => ({ error: "Couldn't add them. Try again." }));
    if (res.error) {
      setError(res.error);
      return;
    }
    setText("");
    setAnswer({ q: "", rows: [] });
    onAdded();
  }

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <label className="relative block">
        <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-text-2)]">Add someone to {groupName}</span>
        <UserPlus className="pointer-events-none absolute bottom-3 left-3.5 h-4 w-4 text-[var(--color-faint)]" aria-hidden="true" />
        <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a name or email" className="pl-10" autoComplete="off" maxLength={100} />
      </label>
      {text.trim().length >= GROUP_SEARCH_MIN_CHARS && (
        <ul className="mt-2 flex max-h-64 flex-col overflow-y-auto rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)]" aria-live="polite">
          {results.map((m) => (
            <li key={m.userId} className="border-b border-[var(--color-border)] last:border-b-0">
              <button type="button" onClick={() => void add(m)} className="flex min-h-12 w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none">
                <span className="min-w-0">
                  <span className="block truncate">{m.name ?? m.email}</span>
                  {m.name && <span className="block truncate text-[13px] text-[var(--color-muted)]">{m.email}</span>}
                </span>
                <span className="shrink-0 text-[13px] font-medium text-[var(--color-primary)]">Add</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="px-3.5 py-3 text-sm text-[var(--color-muted)]">{searching ? "Searching..." : "Nobody found who is not already in this group."}</li>}
        </ul>
      )}
      <div className="mt-2">
        <FormError message={error} />
      </div>
    </div>
  );
}
