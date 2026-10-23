"use client";

import { useActionState } from "react";
import { Button, Field, FormError, Input, Select } from "@/components/ui";
import { createInvitationAction, type InviteState } from "./actions";
import { CopyCodeButton } from "./CopyCodeButton";
import { roleChoices } from "@/lib/admin/members";

const initialState: InviteState = {};

export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInvitationAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-text-2)]">
        Make a code and share it with the person joining. They enter it the first time they sign in.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="They join as" htmlFor="role">
          <Select id="role" name="role" defaultValue="student">
            {roleChoices().map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How many people can use it" htmlFor="maxUses" hint="optional">
          <Input id="maxUses" name="maxUses" type="number" inputMode="numeric" min={1} placeholder="No limit" />
        </Field>
        <Field label="Stops working after" htmlFor="expiresInDays" hint="days, optional">
          <Input id="expiresInDays" name="expiresInDays" type="number" inputMode="numeric" min={1} placeholder="Never" />
        </Field>
      </div>
      <div>
        <Button type="submit" pending={pending} pendingLabel="Creating..." className="w-full sm:w-auto">
          Create code
        </Button>
      </div>
      <FormError message={state.error} />
      {state.code && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] bg-[var(--color-success-soft)] px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-[13px] text-[var(--color-success-ink)]">Your new code. Share it with the person joining.</p>
            <code className="font-mono text-xl font-semibold tracking-widest break-all text-[var(--color-success-ink)]">{state.code}</code>
          </div>
          <CopyCodeButton code={state.code} />
        </div>
      )}
    </form>
  );
}
