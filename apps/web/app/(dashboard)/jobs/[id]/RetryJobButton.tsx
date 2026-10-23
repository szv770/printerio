"use client";

import { useActionState } from "react";
import { RotateCw } from "lucide-react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { retryJobAction, type JobActionState } from "./actions";

const initialState: JobActionState = {};

/**
 * "Try again" for a job that failed: re-queues the SAME job (same file, same quota reservation) so the print agent
 * picks it up again. Different from "Print again", which submits a brand-new job through policy and quota.
 */
export function RetryJobButton({ jobId, big = false }: { jobId: string; /** Thumb-sized and full width on a phone (the job page). */ big?: boolean }) {
  const [state, formAction, pending] = useActionState(retryJobAction, initialState);
  if (state.success) return <FormSuccess message={state.success} />;
  return (
    <form action={formAction} className={big ? "w-full sm:w-auto" : undefined}>
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" size={big ? "lg" : "sm"} className={big ? "w-full sm:w-auto" : ""} pending={pending} pendingLabel="Queuing...">
        <span className="flex items-center gap-1.5">
          <RotateCw className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
          Try again
        </span>
      </Button>
      <FormError message={state.error} />
    </form>
  );
}
