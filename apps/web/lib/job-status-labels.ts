import type { JobState } from "@printos/shared";

export const JOB_STATUS_LABELS: Record<JobState, { emoji: string; label: string }> = {
  draft: { emoji: "⚪", label: "Draft" },
  pending_approval: { emoji: "🟡", label: "Awaiting approval" },
  approved: { emoji: "🟢", label: "Approved" },
  denied: { emoji: "🔴", label: "Denied" },
  rejected: { emoji: "🔴", label: "Rejected" },
  expired: { emoji: "⚫", label: "Expired" },
  cancelled: { emoji: "⚫", label: "Cancelled" },
  claimed: { emoji: "🟢", label: "Sent to printer" },
  downloading: { emoji: "🟢", label: "Preparing" },
  downloaded: { emoji: "🟢", label: "Preparing" },
  printing: { emoji: "🟢", label: "Printing…" },
  submitted_to_spooler: { emoji: "🟢", label: "Printing…" },
  completed: { emoji: "✅", label: "Completed" },
  failed: { emoji: "🔴", label: "Failed" },
};

export function jobStatusDisplay(status: string): { emoji: string; label: string } {
  return (JOB_STATUS_LABELS as Record<string, { emoji: string; label: string }>)[status] ?? { emoji: "⚪", label: status };
}
