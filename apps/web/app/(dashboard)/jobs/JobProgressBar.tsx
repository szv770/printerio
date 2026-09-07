import { JOB_STAGE_LABELS, buildJobProgress, jobProgressPosition, type JobStageState } from "@/lib/job-progress";

const SEGMENT: Record<JobStageState, string> = {
  done: "bg-[var(--color-success)]",
  current: "bg-[var(--color-primary)]",
  failed: "bg-[var(--color-danger)]",
  skipped: "bg-[var(--color-border)]",
  upcoming: "bg-[var(--color-border)]",
  unreachable: "bg-[var(--color-border)] opacity-50",
};

/**
 * The same stage model as the job detail page's stepper (lib/job-progress.ts),
 * squeezed into one line for a list row: one segment per real stage, so a
 * glance down the page shows how far each job got and which one stopped
 * early. Discrete segments, never a percentage - the system cannot observe
 * page-by-page printer progress (docs/known-limitations.md).
 */
export function JobProgressBar({
  status,
  policyAction,
  eventTypes,
}: {
  status: string;
  policyAction: string | null;
  /** This job's recorded events - what tells a stopped job's bar where it actually stopped. */
  eventTypes?: string[];
}) {
  const progress = buildJobProgress({ status, policyAction, eventTypes });
  const { step, total } = jobProgressPosition(progress);
  const stageLabel = JOB_STAGE_LABELS[progress.currentStageId];
  const label = progress.halted
    ? `Stopped at: ${stageLabel}`
    : status === "completed"
      ? "All stages finished"
      : `Step ${step} of ${total}: ${stageLabel}`;

  return (
    <span className="flex items-center gap-2" title={label}>
      <span className="flex gap-0.5" aria-hidden>
        {progress.stages.map((stage) => (
          <span key={stage.id} className={`h-1 w-3.5 rounded-full ${SEGMENT[stage.state]}`} />
        ))}
      </span>
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
    </span>
  );
}
