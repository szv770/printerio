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
export function RetryJobButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(retryJobAction, initialState);
  if (state.success) return <FormSuccess message={state.success} />;
  return (
    <form action={formAction}>
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" size="sm" pending={pending} pendingLabel="Queuing...">
        <span className="flex items-center gap-1.5">
          <RotateCw className="h-3.5 w-3.5" />
          Try again
        </span>
      </Button>
      <FormError message={state.error} />
    </form>
  );
}
