"use client";

import { useActionState } from "react";
import { Button, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { updateDisplayNameAction, type ProfileActionState } from "./actions";

const initialState: ProfileActionState = {};

export function ProfileForm({ displayName }: { displayName: string | null }) {
  const [state, formAction, pending] = useActionState(updateDisplayNameAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3" aria-busy={pending}>
      <Field label="Display name" htmlFor="displayName" help="This is the name people see next to your print jobs.">
        <Input id="displayName" name="displayName" defaultValue={displayName ?? ""} required disabled={pending} aria-describedby="displayName-desc" />
      </Field>
      <FormError message={state.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending} pendingLabel="Saving..." className="w-full sm:w-auto">
          Save name
        </Button>
        {!pending && <FormSuccess message={state.saved ? "Saved." : null} />}
      </div>
    </form>
  );
}
