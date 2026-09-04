"use client";

import { useActionState } from "react";
import { redeemInvitationAction, type RedeemState } from "./actions";

const initialState: RedeemState = {};

export function RedeemForm() {
  const [state, formAction, pending] = useActionState(redeemInvitationAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="code" className="text-sm font-medium">
        Enrollment code
      </label>
      <input
        id="code"
        name="code"
        required
        autoFocus
        className="rounded-lg border border-[var(--color-border)] px-4 py-3 text-base"
        placeholder="e.g. a1b2c3d4e5f6"
      />
      {state.error ? <p className="text-sm text-[var(--color-danger)]">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[var(--color-primary)] px-4 py-3 text-base font-medium text-[var(--color-primary-fg)] disabled:opacity-60"
      >
        {pending ? "Joining..." : "Join organization"}
      </button>
    </form>
  );
}
