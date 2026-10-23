import type { JobState } from "@printio/shared";

export type HeadlineTone = "neutral" | "live" | "success" | "warning" | "danger";

const HEADLINES: Record<JobState, { sentence: string; tone: HeadlineTone }> = {
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
  completed: { sentence: "Done. It printed.", tone: "success" },
  failed: { sentence: "It didn't print", tone: "danger" },
};

/** The one big plain sentence at the top of a job's page. Display only: status itself is decided elsewhere. */
export function jobHeadline(status: string): { sentence: string; tone: HeadlineTone } {
  return (HEADLINES as Record<string, { sentence: string; tone: HeadlineTone }>)[status] ?? { sentence: "Status unknown", tone: "neutral" };
}
