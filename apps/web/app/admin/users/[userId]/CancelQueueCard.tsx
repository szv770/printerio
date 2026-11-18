"use client";

import { useActionState, useState } from "react";
import { OctagonX } from "lucide-react";
import { Button, Card, FormError, FormSuccess } from "@/components/ui";
import { cancelMemberQueueAction, type CancelQueueState } from "../actions";

const initial: CancelQueueState = {};

/** The emergency stop for one person: cancels every job of theirs that has not started printing. Two presses, so it is never accidental. */
export function CancelQueueCard({ userId, firstName }: { userId: string; firstName: string }) {
  const [state, action, pending] = useActionState(cancelMemberQueueAction, initial);
  const [sure, setSure] = useState(false);
  return (
    <Card className="mb-4">
      <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
        <OctagonX className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
        Waiting jobs
      </h2>
      <p className="text-[13px] text-[var(--color-muted)]">
        If {firstName} sent too much, cancel everything of theirs that has not started printing. Their quota is given back. Disabling or removing a person does this automatically.
      </p>
      <form action={action} className="mt-3 flex flex-wrap items-center gap-2" onSubmit={() => setSure(false)}>
        <input type="hidden" name="userId" value={userId} />
        {!sure ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setSure(true)}>
            Cancel all of {firstName}&apos;s waiting jobs
          </Button>
        ) : (
          <>
            <Button type="submit" variant="danger" size="sm" pending={pending} pendingLabel="Cancelling...">
              Yes, cancel them all
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSure(false)} disabled={pending}>
              No, keep them
            </Button>
          </>
        )}
      </form>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
    </Card>
  );
}
