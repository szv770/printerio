"use client";

import { useActionState } from "react";
import { Button, Input, FieldLabel, FormError } from "@/components/ui";
import { redeemInvitationAction, type RedeemState } from "./actions";

const initialState: RedeemState = {};

export function RedeemForm() {
  const [state, formAction, pending] = useActionState(redeemInvitationAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FieldLabel htmlFor="code">Enrollment code</FieldLabel>
      <Input id="code" name="code" required autoFocus placeholder="e.g. a1b2c3d4e5f6" />
      <FormError message={state.error} />
      <Button type="submit" pending={pending} pendingLabel="Joining...">
        Join organization
      </Button>
    </form>
  );
}
