"use client";

import { useActionState } from "react";
import { Button, Input, Select, FieldLabel, FormError, Card } from "@/components/ui";
import { createInvitationAction, type InviteState } from "./actions";

const initialState: InviteState = {};

export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInvitationAction, initialState);

  return (
    <Card>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div>
          <FieldLabel htmlFor="role">Role</FieldLabel>
          <Select id="role" name="role" defaultValue="student">
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="approver">Approver</option>
            <option value="org_admin">Org admin</option>
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="maxUses">Max uses</FieldLabel>
          <Input id="maxUses" name="maxUses" type="number" min={1} placeholder="unlimited" className="w-28" />
        </div>
        <div>
          <FieldLabel htmlFor="expiresInDays">Expires in (days)</FieldLabel>
          <Input id="expiresInDays" name="expiresInDays" type="number" min={1} placeholder="never" className="w-28" />
        </div>
        <Button type="submit" size="sm" pending={pending} pendingLabel="Creating...">
          Create code
        </Button>
        <FormError message={state.error} />
        {state.code && (
          <p className="w-full text-sm">
            Enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{state.code}</code> — share this with the
            person joining.
          </p>
        )}
      </form>
    </Card>
  );
}
