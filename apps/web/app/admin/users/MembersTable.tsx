"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Select, Input, Button, EmptyState, FormError, Badge } from "@/components/ui";
import { routes } from "@/lib/routes";
import {
  changeMemberRoleAction,
  changeMemberDepartmentAction,
  toggleMemberStatusAction,
  removeMemberAction,
  type RoleChangeState,
  type DepartmentChangeState,
  type StatusChangeState,
  type RemoveMemberState,
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
const initialStatusState: StatusChangeState = {};
const initialRemoveState: RemoveMemberState = {};

export function MembersTable({ members, canEdit }: { members: Member[]; canEdit: boolean }) {
  if (members.length === 0) return <EmptyState message="No members yet." icon={Users} />;

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
            {canEdit && <th className="py-2 pr-4">Actions</th>}
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
  const [statusState, statusAction] = useActionState(toggleMemberStatusAction, initialStatusState);
  const [removeState, removeAction] = useActionState(removeMemberAction, initialRemoveState);

  const detailHref = routes.adminUserDetail(member.userId);

  return (
    <tr className="border-b border-[var(--color-border)]">
      <td className="py-2 pr-4">
        <Link href={detailHref} className="font-medium hover:underline">
          {member.displayName ?? "—"}
        </Link>
      </td>
      <td className="py-2 pr-4">
        <Link href={detailHref} className="hover:underline">
          {member.email}
        </Link>
      </td>
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
      <td className="py-2 pr-4">
        {canEdit ? (
          <form action={statusAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="userId" value={member.userId} />
            <input type="hidden" name="status" value={member.status === "active" ? "disabled" : "active"} />
            <Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge>
            <button type="submit" className="text-xs text-[var(--color-primary)]">
              {member.status === "active" ? "Disable" : "Re-enable"}
            </button>
          </form>
        ) : (
          <Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge>
        )}
        <FormError message={statusState.error} />
      </td>
      {canEdit && (
        <td className="py-2 pr-4">
          <form
            action={removeAction}
            onSubmit={(e) => {
              if (!confirm(`Remove ${member.displayName ?? member.email} from this organization? This does not delete their account.`)) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="userId" value={member.userId} />
            <Button type="submit" variant="outline-danger" size="sm">
              Remove
            </Button>
          </form>
          <FormError message={removeState.error} />
        </td>
      )}
    </tr>
  );
}
