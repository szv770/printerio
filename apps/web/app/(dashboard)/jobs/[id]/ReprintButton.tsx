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
export function ReprintButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(reprintJobAction, initialSubmitJobState);

  return (
    <form action={formAction}>
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" variant="outline" size="sm" pending={pending} pendingLabel="Submitting...">
        <span className="flex items-center gap-1.5">
          <RotateCw className="h-3.5 w-3.5" />
          Print again
        </span>
      </Button>
      <FormError message={state.error} />
    </form>
  );
}
