"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Trash2, Users } from "lucide-react";
import {
  Badge,
  EmptyState,
  FieldError,
  FormError,
  Input,
  SAVE_BAR_CLEARANCE,
  SaveBar,
  Select,
  Switch,
  ResponsiveTable,
  type TableColumn,
} from "@/components/ui";
import { routes } from "@/lib/routes";
import {
  changeMemberRoleAction,
  changeMemberDepartmentAction,
  changeMemberUserCodeAction,
  toggleMemberStatusAction,
  removeMemberAction,
  type RemoveMemberState,
} from "./actions";
import { roleLabel } from "@/lib/role-label";
import {
  changedMembers,
  filterMembers,
  memberActionFields,
  roleChoices,
  type MemberActionId,
  type MemberDraft,
  type MemberListItem,
} from "@/lib/admin/members";

interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  department: string | null;
  /** Stored organization_members.user_code (null = not set). */
  userCode: string | null;
  /** The code that is actually stamped (stored, or generated while none is set). */
  effectiveCode: string;
}

// The existing server actions are unchanged; Save calls each one that has a
// change, member by member, with exactly the fields it always read.
const ACTIONS: Record<MemberActionId, (prev: { error?: string }, fd: FormData) => Promise<{ error?: string }>> = {
  role: changeMemberRoleAction,
  department: changeMemberDepartmentAction,
  userCode: changeMemberUserCodeAction,
  status: toggleMemberStatusAction,
};

const ACTION_FIELD: Record<MemberActionId, keyof MemberDraft> = {
  role: "role",
  department: "department",
  userCode: "userCode",
  status: "status",
};

function toDraft(m: Member): MemberDraft {
  return { role: m.role, department: m.department ?? "", userCode: m.userCode ?? "", status: m.status };
}

function initials(m: Member): string {
  const src = (m.displayName ?? m.email).trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function MembersTable({ members, canEdit }: { members: Member[]; canEdit: boolean }) {
  const [baselines, setBaselines] = useState<Record<string, MemberDraft>>({});
  const [drafts, setDrafts] = useState<Record<string, MemberDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const byId = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  const baselineOf = (m: Member): MemberDraft => baselines[m.userId] ?? toDraft(m);
  const draftOf = (m: Member): MemberDraft => drafts[m.userId] ?? baselineOf(m);

  const allBaselines = Object.fromEntries(members.map((m) => [m.userId, baselineOf(m)]));
  const allDrafts = Object.fromEntries(members.map((m) => [m.userId, draftOf(m)]));
  const changes = changedMembers(allBaselines, allDrafts);
  const dirtyIds = new Set(changes.map((c) => c.userId));
  const failedCount = Object.keys(errors).length;

  function edit(m: Member, patch: Partial<MemberDraft>) {
    setDrafts((d) => ({ ...d, [m.userId]: { ...draftOf(m), ...patch } }));
    // Editing a row with an error clears its error.
    setErrors((e) => {
      if (!(m.userId in e)) return e;
      const next = { ...e };
      delete next[m.userId];
      return next;
    });
  }

  async function save() {
    if (saving || changes.length === 0) return;
    setSaving(true);
    setErrors({});
    const nextErrors: Record<string, string> = {};
    const nextBaselines = { ...baselines };
    for (const change of changes) {
      const m = byId.get(change.userId);
      if (!m) continue;
      const draft = draftOf(m);
      let base = baselineOf(m);
      for (const action of change.actions) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(memberActionFields(action, m.userId, draft))) fd.set(k, v);
        try {
          const res = await ACTIONS[action]({}, fd);
          if (res.error) {
            nextErrors[m.userId] = res.error;
            break; // the rest of this person's changes wait; other people still save
          }
          base = { ...base, [ACTION_FIELD[action]]: draft[ACTION_FIELD[action]] };
        } catch {
          nextErrors[m.userId] = "Couldn't save. Check your connection and try again.";
          break;
        }
      }
      nextBaselines[m.userId] = base;
    }
    setBaselines(nextBaselines);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      setDrafts({});
      setSavedAt((n) => (n ?? 0) + 1);
    }
    setSaving(false);
  }

  function discard() {
    setDrafts({});
    setErrors({});
  }

  if (members.length === 0) return <EmptyState message="No users yet. Invite someone to get started." icon={Users} />;

  const listItems: MemberListItem[] = members.map((m) => {
    const d = draftOf(m);
    return {
      userId: m.userId,
      displayName: m.displayName,
      email: m.email,
      role: d.role,
      status: d.status,
      department: d.department || null,
      code: d.userCode || m.effectiveCode,
    };
  });
  const visibleIds = new Set(filterMembers(listItems, { query, role: roleFilter, status: statusFilter }).map((m) => m.userId));
  const visible = members.filter((m) => visibleIds.has(m.userId));
  const filtering = query.trim() !== "" || roleFilter !== "" || statusFilter !== "";

  const columns: TableColumn<Member>[] = [
    {
      header: "Name",
      primary: true,
      cell: (m) => {
        const d = draftOf(m);
        return (
          <div className="flex items-start gap-3 md:max-w-[17rem]">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
                d.status === "active"
                  ? "bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]"
                  : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
              }`}
            >
              {initials(m)}
            </span>
            <div className="min-w-0 flex-1">
              <Link href={routes.adminUserDetail(m.userId)} className="-my-2.5 block truncate py-2.5 font-medium hover:underline">
                {m.displayName ?? m.email}
              </Link>
              {m.displayName && <p className="truncate text-[13px] font-normal text-[var(--color-muted)]">{m.email}</p>}
              {dirtyIds.has(m.userId) && !errors[m.userId] && (
                <span className="mt-1 inline-block">
                  <Badge tone="accent">Edited</Badge>
                </span>
              )}
              {errors[m.userId] && (
                <div className="mt-1 font-normal">
                  <FieldError message={errors[m.userId]} />
                </div>
              )}
            </div>
            {canEdit && <RemoveButton member={m} />}
          </div>
        );
      },
    },
    {
      header: "Print code",
      cell: (m) =>
        canEdit ? (
          <Input
            value={draftOf(m).userCode}
            onChange={(e) => edit(m, { userCode: e.target.value })}
            placeholder={m.effectiveCode}
            maxLength={12}
            aria-label={`Print code for ${m.displayName ?? m.email}`}
            className="ml-auto w-24 min-w-24 text-center font-mono text-sm tracking-wider uppercase"
            invalid={!!errors[m.userId]}
          />
        ) : (
          <code className="rounded-md bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs tracking-wider">{m.effectiveCode}</code>
        ),
    },
    {
      header: "Role",
      cell: (m) =>
        canEdit ? (
          <Select
            value={draftOf(m).role}
            onChange={(e) => edit(m, { role: e.target.value })}
            aria-label={`Role for ${m.displayName ?? m.email}`}
            className="ml-auto w-full min-w-36 text-sm sm:w-32 sm:min-w-32"
          >
            {roleChoices().map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        ) : (
          <Badge>{roleLabel(m.role)}</Badge>
        ),
    },
    {
      header: "Department",
      cell: (m) =>
        canEdit ? (
          <Input
            value={draftOf(m).department}
            onChange={(e) => edit(m, { department: e.target.value })}
            placeholder="None"
            aria-label={`Department for ${m.displayName ?? m.email}`}
            className="ml-auto w-full min-w-36 text-sm sm:w-32 sm:min-w-32"
          />
        ) : (
          (m.department ?? "None")
        ),
    },
    {
      header: "Status",
      cell: (m) => {
        const active = draftOf(m).status === "active";
        return canEdit ? (
          <Switch
            label={active ? "Active" : "Off"}
            checked={active}
            onChange={(e) => edit(m, { status: e.target.checked ? "active" : "disabled" })}
            aria-label={`${m.displayName ?? m.email} can sign in and print`}
            className="justify-end gap-3 py-0"
          />
        ) : (
          <Badge tone={active ? "success" : "neutral"}>{active ? "Active" : "Off"}</Badge>
        );
      },
    },
  ];

  const barError =
    failedCount > 0
      ? failedCount === 1
        ? "One person's changes couldn't be saved. Everyone else was saved."
        : `${failedCount} people's changes couldn't be saved. Everyone else was saved.`
      : null;

  return (
    <div className={canEdit ? SAVE_BAR_CLEARANCE : ""}>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-[1fr_auto_auto]">
        <label className="relative col-span-2 sm:col-span-1">
          <span className="sr-only">Search users</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[var(--color-faint)]" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, department or code"
            className="pl-10"
          />
        </label>
        <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Show role" className="sm:w-40">
          <option value="">All roles</option>
          {roleChoices().map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Show status" className="sm:w-40">
          <option value="">Everyone</option>
          <option value="active">Active</option>
          <option value="disabled">Off</option>
        </Select>
      </div>
      <p className="mb-3 text-[13px] text-[var(--color-muted)]" aria-live="polite">
        {filtering ? `${visible.length} of ${members.length} users` : `${members.length} ${members.length === 1 ? "user" : "users"}`}
      </p>

      {visible.length === 0 ? (
        <EmptyState message="Nobody matches that search." icon={Search} />
      ) : (
        <ResponsiveTable columns={columns} rows={visible} rowKey={(m) => m.userId} caption="Users" />
      )}

      {canEdit && <SaveBar dirty={changes.length > 0} saving={saving} savedAt={savedAt} error={barError} onSave={() => void save()} onDiscard={discard} />}
    </div>
  );
}

const initialRemoveState: RemoveMemberState = {};

/** Taking someone out is its own deliberate step (with a confirm), not part of Save. */
function RemoveButton({ member }: { member: Member }) {
  const [state, action, pending] = useActionState(removeMemberAction, initialRemoveState);
  const name = member.displayName ?? member.email;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Remove ${name} from this organization? This does not delete their account.`)) e.preventDefault();
      }}
      className="shrink-0"
    >
      <input type="hidden" name="userId" value={member.userId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Remove ${name}`}
        title="Remove from this organization"
        className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
      {state.error && (
        <div className="mt-1 max-w-48 font-normal">
          <FormError message={state.error} />
        </div>
      )}
    </form>
  );
}
