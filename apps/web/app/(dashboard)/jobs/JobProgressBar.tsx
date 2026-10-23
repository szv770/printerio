import { JOB_STAGE_LABELS, buildJobProgress, jobProgressPosition, type JobProgress, type JobStageState } from "@/lib/job-progress";

const SEGMENT: Record<JobStageState, string> = {
  done: "bg-[var(--ink-c)]",
  current: "bg-[var(--ink-c)] opacity-45",
  failed: "bg-[var(--ink-m)]",
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
  isTestPrint,
  progress: given,
  large = false,
}: {
  status: string;
  policyAction: string | null;
  /** This job's recorded events - what tells a stopped job's bar where it actually stopped. */
  eventTypes?: string[];
  /** print_jobs.is_test_print - so the bar shows the print-rules stage as
   *  skipped, matching what actually happened to this job. */
  isTestPrint?: boolean;
  /** Already-built progress (the detail page has the full inputs); otherwise it is built from the fields above. */
  progress?: JobProgress;
  /** The detail page bigger bar. */
  large?: boolean;
}) {
  const progress = given ?? buildJobProgress({ status, policyAction, eventTypes, isTestPrint });
  const { step, total } = jobProgressPosition(progress);
  const stageLabel = JOB_STAGE_LABELS[progress.currentStageId];
  const label = progress.halted
    ? `Stopped at: ${stageLabel}`
    : status === "completed"
      ? "All stages finished"
      : `Step ${step} of ${total}: ${stageLabel}`;

  return (
    <span className="flex flex-col gap-1.5" title={label}>
      <span className={large ? "flex flex-1 gap-1.5" : "flex flex-1 gap-1 sm:max-w-56"} aria-hidden>
        {progress.stages.map((stage) => (
          <span key={stage.id} className={`${large ? "h-2.5" : "h-1.5"} flex-1 rounded-full ${SEGMENT[stage.state]}`} />
        ))}
      </span>
      <span className={large ? "sr-only" : "text-xs text-[var(--color-muted)]"}>{label}</span>
    </span>
  );
}
