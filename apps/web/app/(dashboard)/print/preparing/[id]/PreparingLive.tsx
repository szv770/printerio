"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, FormError } from "@/components/ui";
import { startVisibleInterval } from "@/lib/ui/visible-interval";
import { cancelPrepareAction, confirmPrepareBookletAction, type PrepareActionState } from "../actions";

const initial: PrepareActionState = {};
/** The page asks the website again this often while the file is being prepared (a few seconds is normal). */
const REFRESH_MS = 3_000;

/** Keeps the page up to date while preparing: it re-reads the server page, which sends the person on to the job as soon as it exists. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    return startVisibleInterval(() => router.refresh(), REFRESH_MS, document);
  }, [active, router]);
  return null;
}

export function CancelPreparing({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(cancelPrepareAction, initial);
  return (
    <form action={formAction} className="mt-4">
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" variant="outline" disabled={pending}>{pending ? "Cancelling..." : "Cancel"}</Button>
      {state.error ? <FormError message={state.error} /> : null}
    </form>
  );
}

export function ConfirmBooklet({ jobId, blankPages }: { jobId: string; blankPages: number }) {
  const [state, formAction, pending] = useActionState(confirmPrepareBookletAction, initial);
  return (
    <form action={formAction} className="mt-4 flex flex-wrap gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" disabled={pending}>{pending ? "Working..." : `Yes, add ${blankPages} blank ${blankPages === 1 ? "page" : "pages"}`}</Button>
      {state.error ? <FormError message={state.error} /> : null}
    </form>
  );
}
