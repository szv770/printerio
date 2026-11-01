import type { StepView, UpdateView } from "./update-progress";

export interface ToastSummary {
  tone: "primary" | "success" | "danger";
  title: string;
  detail: string;
  /** True while something is still running (shows a spinner and a clock). */
  live: boolean;
  /** When it started (ISO), for the elapsed clock. */
  since: string | null;
}

function holdingAt(steps: StepView[]): string {
  const i = steps.findIndex((s) => s.state === "active");
  if (i >= 0) return `Step ${i + 1} of ${steps.length}: ${steps[i]!.label}`;
  const next = steps.findIndex((s) => s.state === "pending");
  return next >= 0 ? `Step ${next + 1} of ${steps.length}: ${steps[next]!.label}` : "Finishing up";
}

/** What the floating update notification should say for the current update state, or null when nothing is running or just ended. */
export function toastSummary(view: UpdateView): ToastSummary | null {
  switch (view.kind) {
    case "updating":
      return { tone: "primary", title: "Updating the print server", detail: view.message ?? holdingAt(view.steps), live: true, since: view.startedAt };
    case "restarting":
      return { tone: "primary", title: "Restarting the print server", detail: holdingAt(view.steps), live: true, since: null };
    case "done":
      return { tone: "success", title: "Print server updated", detail: view.to ? `Now running ${view.to}` : "Update finished", live: false, since: null };
    case "failed":
      return { tone: "danger", title: "Update did not finish", detail: view.message, live: false, since: null };
    default:
      return null;
  }
}
