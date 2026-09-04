"use client";

import { useActionState } from "react";
import { changeMemberRoleAction, type RoleChangeState } from "./actions";

interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
}

const initialState: RoleChangeState = {};

export function MembersTable({ members, canEdit }: { members: Member[]; canEdit: boolean }) {
  if (members.length === 0) return <p className="text-sm text-[var(--color-muted)]">No members yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Email</th>
            <th className="py-2 pr-4">Role</th>
            <th className="py-2 pr-4">Status</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <MemberRow key={m.userId} member={m} canEdit={canEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({ member, canEdit }: { member: Member; canEdit: boolean }) {
  const [state, formAction] = useActionState(changeMemberRoleAction, initialState);

  return (
    <tr className="border-b border-[var(--color-border)]">
      <td className="py-2 pr-4">{member.displayName ?? "—"}</td>
      <td className="py-2 pr-4">{member.email}</td>
      <td className="py-2 pr-4">
        {canEdit ? (
          <form action={formAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="userId" value={member.userId} />
            <select name="role" defaultValue={member.role} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">
              <option value="student">Student</option>
              <option value="staff">Staff</option>
              <option value="approver">Approver</option>
              <option value="org_admin">Org admin</option>
            </select>
            <button type="submit" className="text-xs text-[var(--color-primary)]">
              Save
            </button>
          </form>
        ) : (
          member.role
        )}
        {state.error && <span className="ml-2 text-xs text-[var(--color-danger)]">{state.error}</span>}
      </td>
      <td className="py-2 pr-4">{member.status}</td>
    </tr>
  );
}
