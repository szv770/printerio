"use client";

import { useActionState } from "react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { updateRememberLastAction, type ProfileActionState } from "./actions";

const initialState: ProfileActionState = {};

/** The one print-page setting: start from the last choices (default off). Only rendered when the preferences table exists. */
export function PrintPreferencesForm({ rememberLast }: { rememberLast: boolean }) {
  const [state, formAction, pending] = useActionState(updateRememberLastAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3" aria-busy={pending}>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm">
        <input
          type="checkbox"
          name="rememberLast"
          defaultChecked={rememberLast}
          disabled={pending}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
        />
        <span>
          <span className="block font-medium">Remember my last print choices</span>
          <span className="mt-0.5 block text-[13px] text-[var(--color-muted)]">Start the print page with what I chose last time (booklet always starts off).</span>
        </span>
      </label>
      <FormError message={state.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending} pendingLabel="Saving..." className="w-full sm:w-auto">
          Save
        </Button>
        {!pending && <FormSuccess message={state.saved ? "Saved." : null} />}
      </div>
    </form>
  );
}
