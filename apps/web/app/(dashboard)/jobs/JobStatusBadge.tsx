import { StatusDot, type StatusTone } from "@/components/ui";
import { jobStatusDisplay } from "@/lib/job-status-labels";

/**
 * One job's status as a colored dot plus its word. Ink colors do the work at a
 * glance (cyan moving, yellow waiting on someone, green done, magenta a
 * problem); the word is always there too, so color is never the only signal.
 */
export function JobStatusBadge({ status }: { status: string }) {
  const { label, tone, spinning } = jobStatusDisplay(status);
  const dot: StatusTone = spinning ? "live" : tone;
  return <StatusDot tone={dot}>{label}</StatusDot>;
}
