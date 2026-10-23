"use client";

import { useActionState } from "react";
import { RotateCw } from "lucide-react";
import { Button, FormError } from "@/components/ui";
import { reprintJobAction, type SubmitJobState } from "../../print/actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialSubmitJobState: SubmitJobState = {};

/**
 * Re-submits this exact job (same file, same settings) as a brand-new job,
 * without the user re-selecting the file - reprintJobAction re-downloads the
 * original bytes from storage server-side. Redirects to the new job's
 * status page on success, same as a fresh submission.
 */
export function ReprintButton({ jobId, big = false, primary = false }: { jobId: string; /** Thumb-sized and full width on a phone (the job page). */ big?: boolean; /** The main action of the page (a finished job). */ primary?: boolean }) {
  const [state, formAction, pending] = useActionState(reprintJobAction, initialSubmitJobState);

  return (
    <form action={formAction} className={big ? "w-full sm:w-auto" : undefined}>
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" variant={primary ? "primary" : "outline"} size={big ? "lg" : "sm"} className={big ? "w-full sm:w-auto" : ""} pending={pending} pendingLabel="Submitting...">
        <span className="flex items-center gap-1.5">
          <RotateCw className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
          Print again
        </span>
      </Button>
      <FormError message={state.error} />
    </form>
  );
}
