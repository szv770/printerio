"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Select, Input, Button, FieldLabel, FormError, Badge } from "@/components/ui";
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
} from "../actions";

export interface DetailMember {
  userId: string;
  role: string;
  status: string;
  department: string | null;
}

const initialRoleState: RoleChangeState = {};
const initialDeptState: DepartmentChangeState = {};
const initialStatusState: StatusChangeState = {};
const initialRemoveState: RemoveMemberState = {};

/** The same role/department/status editing MembersTable's row offers, laid
 *  out with room to breathe instead of crammed into a table cell - plus
 *  "Remove from organization", which the roster row also has but which reads
 *  clearer with its own confirm copy here. Read-only (canEdit false, i.e. an
 *  approver viewing the page) just shows the values as plain badges/text. */
export function MemberDetailControls({ member, canEdit }: { member: DetailMember; canEdit: boolean }) {
  const router = useRouter();
  const [roleState, roleAction] = useActionState(changeMemberRoleAction, initialRoleState);
  const [deptState, deptAction] = useActionState(changeMemberDepartmentAction, initialDeptState);
  const [statusState, statusAction] = useActionState(toggleMemberStatusAction, initialStatusState);
  const [removeState, removeAction] = useActionState(removeMemberAction, initialRemoveState);

  // Once removal succeeds there's no member left to show on this page - the
  // next fetch of it 404s - so navigate back to the roster right away rather
  // than leaving the admin looking at a page for someone who's already gone.
  useEffect(() => {
    if (removeState.success) router.replace(routes.adminUsers);
  }, [removeState.success, router]);

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <div>
          <p className="mb-1 text-[var(--color-muted)]">Role</p>
          <Badge>{member.role}</Badge>
        </div>
        <div>
          <p className="mb-1 text-[var(--color-muted)]">Department</p>
          <p className="font-medium">{member.department ?? "—"}</p>
        </div>
        <div>
          <p className="mb-1 text-[var(--color-muted)]">Status</p>
          <Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 text-sm">
      <form action={roleAction} className="flex items-end gap-2">
        <input type="hidden" name="userId" value={member.userId} />
        <div>
          <FieldLabel htmlFor="role">Role</FieldLabel>
          <Select id="role" name="role" defaultValue={member.role} className="w-auto">
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="approver">Approver</option>
            <option value="org_admin">Org admin</option>
          </Select>
        </div>
        <Button type="submit" size="sm">
          Save
        </Button>
        <FormError message={roleState.error} />
      </form>

      <form action={deptAction} className="flex items-end gap-2">
        <input type="hidden" name="userId" value={member.userId} />
        <div>
          <FieldLabel htmlFor="department">Department</FieldLabel>
          <Input id="department" name="department" defaultValue={member.department ?? ""} placeholder="—" className="w-full sm:w-40" />
        </div>
        <Button type="submit" size="sm">
          Save
        </Button>
        <FormError message={deptState.error} />
      </form>

      <form action={statusAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="userId" value={member.userId} />
        <input type="hidden" name="status" value={member.status === "active" ? "disabled" : "active"} />
        <span className="text-[var(--color-muted)]">Status</span>
        <Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge>
        <Button type="submit" variant="outline" size="sm">
          {member.status === "active" ? "Disable" : "Re-enable"}
        </Button>
        <FormError message={statusState.error} />
      </form>

      <form
        action={removeAction}
        onSubmit={(e) => {
          if (!confirm("Remove this person from the organization? This does not delete their account - they can be re-invited later."))
            e.preventDefault();
        }}
      >
        <input type="hidden" name="userId" value={member.userId} />
        <Button type="submit" variant="outline-danger" size="sm">
          Remove from organization
        </Button>
        <FormError message={removeState.error} />
      </form>
    </div>
  );
}
