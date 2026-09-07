import { AlertTriangle, Check, Circle, Loader2, MinusCircle } from "lucide-react";
import type { JobProgress, JobProgressStage, JobStageState } from "@/lib/job-progress";

/**
 * The "where is my job up to" view: the real pipeline as an ordered list of
 * stages, with the one the job is on right now marked, the ones behind it
 * ticked, and the ones ahead of it visibly still ahead.
 *
 * Stage membership and per-stage state come entirely from lib/job-progress.ts,
 * which derives them from packages/shared's state machine and the job's own
 * print_job_events rows - this file only draws them. There is no percentage
 * anywhere on purpose: the system cannot observe page-by-page printer
 * progress (docs/known-limitations.md), so a progress bar would be a lie
 * where a stage list is the truth.
 */

const DOT: Record<JobStageState, { ring: string; icon: typeof Check | null; iconClass: string }> = {
  done: { ring: "border-[var(--color-success)] bg-[var(--color-success)]", icon: Check, iconClass: "text-white" },
  current: { ring: "border-[var(--color-primary)] bg-[var(--color-surface)]", icon: null, iconClass: "" },
  upcoming: { ring: "border-[var(--color-border)] bg-[var(--color-surface)]", icon: null, iconClass: "" },
  failed: { ring: "border-[var(--color-danger)] bg-[var(--color-danger)]", icon: AlertTriangle, iconClass: "text-white" },
  skipped: {
    ring: "border-[var(--color-border)] bg-[var(--color-surface)]",
    icon: MinusCircle,
    iconClass: "text-[var(--color-muted)]",
  },
  unreachable: {
    ring: "border-[var(--color-border)] bg-[var(--color-surface)] opacity-50",
    icon: null,
    iconClass: "",
  },
};

const LABEL_CLASS: Record<JobStageState, string> = {
  done: "text-[var(--color-text)]",
  current: "text-[var(--color-text)] font-semibold",
  upcoming: "text-[var(--color-muted)]",
  failed: "text-[var(--color-danger)] font-semibold",
  skipped: "text-[var(--color-muted)]",
  unreachable: "text-[var(--color-muted)] opacity-60",
};

function StageDot({ stage, spinning }: { stage: JobProgressStage; spinning: boolean }) {
  const dot = DOT[stage.state];
  const Icon = dot.icon;

  if (stage.state === "current") {
    return (
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${dot.ring}`}
        aria-hidden
      >
        {spinning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-primary)]" />
        ) : (
          <Circle className="h-2.5 w-2.5 fill-[var(--color-primary)] text-[var(--color-primary)]" />
        )}
      </span>
    );
  }

  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${dot.ring}`}
      aria-hidden
    >
      {Icon ? <Icon className={`h-3.5 w-3.5 ${dot.iconClass}`} /> : null}
    </span>
  );
}

/** Human words for a screen reader, so the stepper isn't purely visual. */
const STATE_ANNOUNCEMENT: Record<JobStageState, string> = {
  done: "done",
  current: "in progress now",
  upcoming: "still to come",
  failed: "stopped here",
  skipped: "not needed for this job",
  unreachable: "will not happen",
};

export function JobProgressStepper({
  progress,
  spinning,
  extra,
}: {
  progress: JobProgress;
  /** Whether the current stage represents active machine work (vs. waiting on a human). */
  spinning: boolean;
  /** Optional per-stage extra detail the pure model can't produce (dates, elapsed-time hints). */
  extra?: Partial<Record<JobProgressStage["id"], React.ReactNode>>;
}) {
  return (
    <ol className="flex flex-col" data-testid="job-progress-stepper">
      {progress.stages.map((stage, index) => {
        const isLast = index === progress.stages.length - 1;
        const connectorFilled = stage.state === "done";
        return (
          <li key={stage.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <StageDot stage={stage} spinning={spinning} />
              {!isLast && (
                <span
                  className={`w-0.5 grow ${connectorFilled ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"}`}
                  style={{ minHeight: "0.75rem" }}
                  aria-hidden
                />
              )}
            </div>
            <div className={`${isLast ? "pb-0" : "pb-4"} min-w-0 flex-1`}>
              <p className={`text-sm leading-6 ${LABEL_CLASS[stage.state]}`}>
                {stage.label}
                <span className="sr-only"> - {STATE_ANNOUNCEMENT[stage.state]}</span>
              </p>
              {stage.note && (
                <p className={`text-xs ${stage.state === "failed" ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
                  {stage.note}
                </p>
              )}
              {extra?.[stage.id]}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
