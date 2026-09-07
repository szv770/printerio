import { Badge } from "@/components/ui";
import { jobStatusDisplay } from "@/lib/job-status-labels";

/**
 * One job's status as a tone-coloured pill. The jobs list previously rendered
 * a plain icon + grey label, which meant "Completed", "Awaiting approval" and
 * "Failed" all had the same visual weight - you had to read every row to find
 * the one that went wrong. Colour does that work at a glance; the icon and
 * the word are still there for anyone who can't rely on colour alone.
 */
export function JobStatusBadge({ status }: { status: string }) {
  const { Icon, label, tone } = jobStatusDisplay(status);
  return (
    <Badge tone={tone}>
      <span className="flex items-center gap-1">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </span>
    </Badge>
  );
}
