"use client";

import { useActionState } from "react";
import { Select, Input, EmptyState, FormError, Badge } from "@/components/ui";
import {
  changeMemberRoleAction,
  changeMemberDepartmentAction,
  type RoleChangeState,
  type DepartmentChangeState,
} from "./actions";

interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  department: string | null;
}

const initialRoleState: RoleChangeState = {};
const initialDeptState: DepartmentChangeState = {};

export function MembersTable({ members, canEdit }: { members: Member[]; canEdit: boolean }) {
  if (members.length === 0) return <EmptyState message="No members yet." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Email</th>
            <th className="py-2 pr-4">Role</th>
            <th className="py-2 pr-4">Department</th>
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
  const [roleState, roleAction] = useActionState(changeMemberRoleAction, initialRoleState);
  const [deptState, deptAction] = useActionState(changeMemberDepartmentAction, initialDeptState);

  return (
    <tr className="border-b border-[var(--color-border)]">
      <td className="py-2 pr-4">{member.displayName ?? "—"}</td>
      <td className="py-2 pr-4">{member.email}</td>
      <td className="py-2 pr-4">
        {canEdit ? (
          <form action={roleAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="userId" value={member.userId} />
            <Select name="role" defaultValue={member.role} className="w-auto py-1 text-xs">
              <option value="student">Student</option>
              <option value="staff">Staff</option>
              <option value="approver">Approver</option>
              <option value="org_admin">Org admin</option>
            </Select>
            <button type="submit" className="text-xs text-[var(--color-primary)]">
              Save
            </button>
          </form>
        ) : (
          <Badge>{member.role}</Badge>
        )}
        <FormError message={roleState.error} />
      </td>
      <td className="py-2 pr-4">
        {canEdit ? (
          <form action={deptAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="userId" value={member.userId} />
            <Input name="department" defaultValue={member.department ?? ""} placeholder="—" className="w-28 py-1 text-xs" />
            <button type="submit" className="text-xs text-[var(--color-primary)]">
              Save
            </button>
          </form>
        ) : (
          (member.department ?? "—")
        )}
        <FormError message={deptState.error} />
      </td>
      <td className="py-2 pr-4">{member.status}</td>
    </tr>
  );
}
