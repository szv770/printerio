/**
 * Which buttons the member job page offers for one job. Pure (unit tested in
 * action-plan.test.ts) so the page only renders what this says.
 *
 * - "Try again" re-queues THIS job after a failure while tries remain.
 * - "Print again" sends a fresh copy through the normal pipeline. It is shown
 *   only when the job is finished or cancelled, or when a failed job can no
 *   longer be retried - never next to "Try again" (that was redundant).
 * - Cancel is offered while nothing has reached the printer.
 */
export interface JobActionInput {
  status: string;
  isOwner: boolean;
  isTestPrint: boolean;
  filesPurged: boolean;
  attemptCount: number;
  maxAttempts: number;
}

export interface JobActionPlan {
  retry: boolean;
  reprint: boolean;
  /** Print again is the main thing to do (finished job, or failed with no tries left). */
  reprintPrimary: boolean;
  cancel: boolean;
  /** The job is already at the printer: no buttons, just a note. */
  atPrinter: boolean;
}

const CANCELLABLE = ["held", "pending_approval", "approved", "failed"];
const AT_PRINTER = ["claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"];
const REPRINTABLE_WHEN_DONE = ["completed", "cancelled", "denied", "rejected", "expired"];

export function jobActionPlan(job: JobActionInput): JobActionPlan {
  const fileOk = !job.filesPurged;
  const retry = job.isOwner && job.status === "failed" && job.attemptCount < job.maxAttempts && fileOk;
  const canReprintJob = !job.isTestPrint && job.isOwner && fileOk;
  const reprint = canReprintJob && (REPRINTABLE_WHEN_DONE.includes(job.status) || (job.status === "failed" && !retry));
  return {
    retry,
    reprint,
    reprintPrimary: reprint && (job.status === "completed" || job.status === "failed"),
    cancel: job.isOwner && CANCELLABLE.includes(job.status),
    atPrinter: job.isOwner && AT_PRINTER.includes(job.status),
  };
}
