"use client";

import { useActionState } from "react";
import Link from "next/link";
import { RotateCw, Zap } from "lucide-react";
import { Button, FormError, buttonClass } from "@/components/ui";
import { routes } from "@/lib/routes";
import { reprintJobAction, type SubmitJobState } from "../../print/actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialSubmitJobState: SubmitJobState = {};

/**
 * "Print again": opens the print page filled in from this job (its file, page count, preview and every choice), as if
 * the document had just been uploaded there. Nothing is sent until the person presses Print, and everything can be
 * changed first. A plain link: the page does the reading and the access check (app/(dashboard)/print/page.tsx).
 */
export function PrintAgainLink({ jobId, big = false, primary = false }: { jobId: string; /** Thumb-sized and full width on a phone (the job page). */ big?: boolean; /** The main action of the page (a finished job). */ primary?: boolean }) {
  return (
    <Link
      href={routes.printAgain(jobId)}
      className={buttonClass(primary ? "primary" : "outline", big ? "lg" : "sm", big ? "w-full sm:w-auto" : "")}
    >
      <span className="flex items-center gap-1.5">
        <RotateCw className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
        Print again
      </span>
    </Link>
  );
}

/**
 * Re-submits this exact job (same file, same settings) as a brand-new job in one click, without opening the print
 * page - reprintJobAction re-downloads the original bytes from storage server-side. Redirects to the new job's
 * status page on success, same as a fresh submission. The secondary button next to "Print again" on the job page;
 * with no `label` it keeps its old "Print again" wording (the jobs list and the design preview still use it).
 */
export function ReprintButton({
  jobId,
  big = false,
  primary = false,
  label = "Print again",
}: {
  jobId: string;
  /** Thumb-sized and full width on a phone (the job page). */
  big?: boolean;
  /** The main action of the page (a finished job). */
  primary?: boolean;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(reprintJobAction, initialSubmitJobState);

  return (
    <form action={formAction} className={big ? "w-full sm:w-auto" : undefined}>
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" variant={primary ? "primary" : "outline"} size={big ? "lg" : "sm"} className={big ? "w-full sm:w-auto" : ""} pending={pending} pendingLabel="Submitting...">
        <span className="flex items-center gap-1.5">
          {label === "Print again" ? <RotateCw className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" /> : <Zap className={big ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />}
          {label}
        </span>
      </Button>
      <FormError message={state.error} />
    </form>
  );
}
