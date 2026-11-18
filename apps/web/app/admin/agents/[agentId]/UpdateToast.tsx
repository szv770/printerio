"use client";

import { useState } from "react";
import { CircleCheck, Minus, TriangleAlert, X, ChevronUp } from "lucide-react";
import { Spinner } from "@/components/ui";
import type { UpdateView } from "@/lib/update-progress";
import { toastSummary } from "@/lib/update-toast";
import { ElapsedClock } from "./ElapsedClock";

const TONE = {
  primary: "border-[var(--color-primary)]/30",
  success: "border-[var(--color-success)]/30",
  danger: "border-[var(--color-danger)]/30",
} as const;

/**
 * A small floating card (bottom right) that says what the print server update is doing right now and where it is
 * holding. Minimise it to a pill, or close it with X; it comes back by itself when the update moves to a new stage.
 */
export function UpdateToast({ view }: { view: UpdateView }) {
  const summary = toastSummary(view);
  // Keyed by the stage so a new stage (for example "failed" after "updating") shows again after an X.
  const stage = summary ? `${view.kind}` : "";
  const [dismissedStage, setDismissedStage] = useState("");
  const [minimised, setMinimised] = useState(false);
  if (!summary || dismissedStage === stage) return null;

  const icon = summary.live ? (
    <Spinner className="h-4 w-4 text-[var(--color-primary)]" />
  ) : summary.tone === "success" ? (
    <CircleCheck className="h-4 w-4 text-[var(--color-success)]" aria-hidden="true" />
  ) : (
    <TriangleAlert className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
  );

  if (minimised) {
    return (
      <div className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 sm:right-6 sm:bottom-6">
        <button
          type="button"
          onClick={() => setMinimised(false)}
          className={`flex items-center gap-2 rounded-full border bg-[var(--color-surface)] px-3.5 py-2 text-sm font-medium shadow-lg ${TONE[summary.tone]}`}
          aria-label={`${summary.title}. Show details`}
        >
          {icon}
          <span>{summary.title}</span>
          <ChevronUp className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed right-4 bottom-4 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-2xl border bg-[var(--color-surface)] p-4 shadow-xl sm:right-6 sm:bottom-6 ${TONE[summary.tone]}`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{summary.title}</p>
          <p className="mt-0.5 text-sm break-words text-[var(--color-text-2)]">{summary.detail}</p>
          {summary.live && summary.since && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              <ElapsedClock since={summary.since} />
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setMinimised(true)}
            className="rounded-md p-1.5 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
            aria-label="Minimise"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setDismissedStage(stage)}
            className="rounded-md p-1.5 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
