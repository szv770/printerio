"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { deleteJobFileAction, type DeleteJobFileState } from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialDeleteFileState: DeleteJobFileState = {};

/**
 * Lets the person who submitted a finished job remove its stored copy now
 * rather than waiting for the organization's retention window. Confirmation
 * is deliberate but lightweight - the consequence is real (the file is gone,
 * and "Print again" stops working for this job) but recoverable by uploading
 * the document again, which the user still has.
 */
export function DeleteFileButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(deleteJobFileAction, initialDeleteFileState);
  const [confirming, setConfirming] = useState(false);

  if (state.success) {
    return <FormSuccess message={state.success} />;
  }

  return (
    <div>
      <FormError message={state.error} />
      {confirming ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="jobId" value={jobId} />
          <p className="w-full text-sm text-[var(--color-muted)]">
            Delete the stored copy of this document? The job and its history stay; only the file is removed, and
            &ldquo;Print again&rdquo; will no longer work for it.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button type="submit" variant="danger" size="sm" pending={pending} pendingLabel="Deleting...">
            Delete the file
          </Button>
        </form>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
          <span className="flex items-center gap-1.5">
            <Trash2 className="h-3.5 w-3.5" />
            Delete stored file
          </span>
        </Button>
      )}
    </div>
  );
}
