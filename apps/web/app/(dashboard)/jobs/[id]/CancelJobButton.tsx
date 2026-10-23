"use client";

import { useActionState, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { cancelJobAction, type JobActionState } from "./actions";

// A "use server" file may only export async functions, so the seed state lives here.
const initialState: JobActionState = {};

/**
 * Cancel your own job from the website, with an inline confirm (no browser dialog): the first click asks, Escape or
 * "Keep it" backs out, and the confirm button is disabled with a spinner while the request runs so a double click
 * cannot send two. The server decides what is allowed; if the job has already gone to the printer it says so plainly
 * (that job cannot be recalled) and the message is shown here.
 */
export function CancelJobButton({ jobId, compact = false, big = false }: { jobId: string; compact?: boolean; /** Thumb-sized and full width on a phone (the job page). */ big?: boolean }) {
  const [state, formAction, pending] = useActionState(cancelJobAction, initialState);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, pending]);

  if (state.success) return <FormSuccess message={state.success} />;

  return (
    <div className={compact ? "text-right" : big ? "w-full sm:w-auto" : undefined}>
      {confirming ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-danger-soft)] p-3" aria-label="Confirm cancel">
          <input type="hidden" name="jobId" value={jobId} />
          <p className="w-full text-sm text-[var(--color-danger-ink)]">Cancel this job? Nothing will be printed and your quota is released.</p>
          <Button type="button" variant="outline" size={big ? "lg" : "sm"} className={big ? "flex-1" : ""} disabled={pending} onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button type="submit" variant="danger" size={big ? "lg" : "sm"} className={big ? "flex-1" : ""} pending={pending} pendingLabel="Cancelling...">
            Yes, cancel it
          </Button>
        </form>
      ) : (
        <Button type="button" variant="outline" size={big ? "lg" : "sm"} className={big ? "w-full sm:w-auto" : ""} onClick={() => setConfirming(true)}>
          <span className="flex items-center gap-1.5">
            <X className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
            Cancel job
          </span>
        </Button>
      )}
      <FormError message={state.error} />
    </div>
  );
}
