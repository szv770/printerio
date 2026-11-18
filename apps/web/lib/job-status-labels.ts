import type { LucideIcon } from "lucide-react";
import { FileEdit, Clock, CheckCircle2, Ban, Slash, Loader2, Printer, CheckCircle, AlertTriangle } from "lucide-react";
import type { JobState } from "@printio/shared";
import { jobWaiting } from "./job-waiting";

export interface JobStatusDisplay {
  Icon: LucideIcon;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  /** Genuinely in-flight right now (vs. a settled/terminal state) - callers
   *  showing a single live job (JobStatusLive.tsx) can spin the icon; list
   *  views showing many rows at once (JobsList.tsx) should ignore this, a
   *  page full of spinning icons is noise, not signal. */
  spinning?: boolean;
}

/**
 * One icon+label+tone per job-state-machine state (packages/shared/src/job-state.ts).
 * Previously this was raw emoji (🟢🟡🔴⚫✅⚪), which had a real bug: three
 * different in-flight states (approved/claimed/downloading/downloaded/printing/
 * submitted_to_spooler) all rendered the identical green circle, so a user
 * genuinely could not tell "approved" from "printing right now" at a glance.
 * Real icons let each stage look different even when they share a tone/color.
 */
export const JOB_STATUS_DISPLAY: Record<JobState, JobStatusDisplay> = {
  draft: { Icon: FileEdit, label: "Draft", tone: "neutral" },
  held: { Icon: Clock, label: "Needs your choices", tone: "warning" },
  pending_approval: { Icon: Clock, label: "Awaiting approval", tone: "warning" },
  approved: { Icon: CheckCircle2, label: "Approved", tone: "success" },
  denied: { Icon: Ban, label: "Denied", tone: "danger" },
  rejected: { Icon: Ban, label: "Rejected", tone: "danger" },
  expired: { Icon: Slash, label: "Expired", tone: "neutral" },
  cancelled: { Icon: Slash, label: "Cancelled", tone: "neutral" },
  claimed: { Icon: Loader2, label: "Sending to printer", tone: "success", spinning: true },
  downloading: { Icon: Loader2, label: "Preparing", tone: "success", spinning: true },
  downloaded: { Icon: Loader2, label: "Preparing", tone: "success", spinning: true },
  printing: { Icon: Printer, label: "Printing…", tone: "success", spinning: true },
  submitted_to_spooler: { Icon: Printer, label: "Printing…", tone: "success", spinning: true },
  completed: { Icon: CheckCircle, label: "Sent to printer", tone: "success" },
  // denied/rejected are dead-end states (packages/shared TERMINAL_STATES);
  // failed is retryable (can transition back to claimed/cancelled) but still
  // reads as a problem, so it gets its own icon rather than sharing Ban.
  failed: { Icon: AlertTriangle, label: "Failed", tone: "danger" },
};

export function jobStatusDisplay(status: string, errorMessage?: string | null): JobStatusDisplay {
  // Waiting for the printer (see lib/job-waiting.ts) is shown as such, never as plain "Approved" and never as failed.
  if (jobWaiting(status, errorMessage)) return { Icon: Clock, label: "Waiting for the printer", tone: "warning" };
  return (JOB_STATUS_DISPLAY as Record<string, JobStatusDisplay>)[status] ?? { Icon: FileEdit, label: status, tone: "neutral" };
}
