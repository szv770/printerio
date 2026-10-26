import type { JobState } from "@printio/shared";
import { jobWaiting } from "./job-waiting";

export type HeadlineTone = "neutral" | "live" | "success" | "warning" | "danger";

const HEADLINES: Record<JobState, { sentence: string; tone: HeadlineTone; detail?: string }> = {
  draft: { sentence: "Getting ready", tone: "neutral" },
  held: { sentence: "Waiting for your choices", tone: "warning" },
  pending_approval: { sentence: "Waiting for approval", tone: "warning" },
  approved: { sentence: "Waiting for the printer", tone: "warning" },
  denied: { sentence: "Not allowed by print rules", tone: "danger" },
  rejected: { sentence: "An approver said no", tone: "danger" },
  expired: { sentence: "This job timed out", tone: "neutral" },
  cancelled: { sentence: "This job was cancelled", tone: "neutral" },
  claimed: { sentence: "Sending to the printer", tone: "live" },
  downloading: { sentence: "Sending to the printer", tone: "live" },
  downloaded: { sentence: "Sending to the printer", tone: "live" },
  printing: { sentence: "Printing now", tone: "live" },
  submitted_to_spooler: { sentence: "Printing now", tone: "live" },
  // For a printer on the direct port Printio knows the job was SENT, not that paper is coming out yet.
  completed: { sentence: "Sent to the printer", tone: "success", detail: "It may take a few moments for the printer to start printing." },
  failed: { sentence: "It didn't print", tone: "danger" },
};

/** The one big plain sentence at the top of a job's page. Display only: status itself is decided elsewhere. */
export function jobHeadline(status: string, errorMessage?: string | null): { sentence: string; tone: HeadlineTone; detail?: string } {
  // A job the printer could not take right now is waiting, not failed: same headline, plus the plain reason.
  const waiting = jobWaiting(status, errorMessage);
  if (waiting) return { sentence: "Waiting for the printer", tone: "warning", detail: waiting.text };
  return (HEADLINES as Record<string, { sentence: string; tone: HeadlineTone; detail?: string }>)[status] ?? { sentence: "Status unknown", tone: "neutral" };
}
