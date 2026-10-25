"use client";

import { useActionState } from "react";
import { Button, Input, FieldLabel, FormError } from "@/components/ui";
import { redeemInvitationAction, type RedeemState } from "./actions";

const initialState: RedeemState = {};

export function RedeemForm({ defaultCode = "", initialError }: { defaultCode?: string; initialError?: string }) {
  const [state, formAction, pending] = useActionState(redeemInvitationAction, initialError ? { error: initialError } : initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FieldLabel htmlFor="code">Invite link or code</FieldLabel>
      <Input id="code" name="code" required autoFocus={!defaultCode} defaultValue={defaultCode} placeholder="Paste the invite link or code" />
      <FormError message={state.error} />
      <Button type="submit" pending={pending} pendingLabel="Joining...">
        Join organization
      </Button>
    </form>
  );
}
