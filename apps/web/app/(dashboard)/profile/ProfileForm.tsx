"use client";

import { useActionState } from "react";
import { Button, Input, FieldLabel, FormError } from "@/components/ui";
import { updateDisplayNameAction, type ProfileActionState } from "./actions";

const initialState: ProfileActionState = {};

export function ProfileForm({ displayName }: { displayName: string | null }) {
  const [state, formAction, pending] = useActionState(updateDisplayNameAction, initialState);

  return (
    <form action={formAction} className="flex max-w-xs flex-col gap-2">
      <FieldLabel htmlFor="displayName">Display name</FieldLabel>
      <Input id="displayName" name="displayName" defaultValue={displayName ?? ""} required />
      <Button type="submit" size="sm" pending={pending} pendingLabel="Saving...">
        Save
      </Button>
      <FormError message={state.error} />
      {state.saved && <p className="text-sm text-[var(--color-success)]">Saved.</p>}
    </form>
  );
}
