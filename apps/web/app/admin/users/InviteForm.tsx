"use client";

import { useActionState } from "react";
import { createInvitationAction, type InviteState } from "./actions";

const initialState: InviteState = {};

export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInvitationAction, initialState);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div>
        <label className="mb-1 block text-xs font-medium">Role</label>
        <select name="role" defaultValue="student" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
          <option value="student">Student</option>
          <option value="staff">Staff</option>
          <option value="approver">Approver</option>
          <option value="org_admin">Org admin</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium">Max uses</label>
        <input name="maxUses" type="number" min={1} placeholder="unlimited" className="w-28 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium">Expires in (days)</label>
        <input name="expiresInDays" type="number" min={1} placeholder="never" className="w-28 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
      </div>
      <button type="submit" disabled={pending} className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-white disabled:opacity-60">
        {pending ? "Creating..." : "Create code"}
      </button>
      {state.error && <p className="w-full text-sm text-[var(--color-danger)]">{state.error}</p>}
      {state.code && (
        <p className="w-full text-sm">
          Enrollment code: <code className="rounded bg-gray-100 px-2 py-1 font-mono">{state.code}</code> — share this with the
          person joining.
        </p>
      )}
    </form>
  );
}
