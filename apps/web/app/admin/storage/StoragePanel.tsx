"use client";

import { useActionState } from "react";
import { CalendarClock, Check, HardDrive, Info, Sparkles } from "lucide-react";
import { Button, Card, Collapsible, FormError } from "@/components/ui";
import { formatFileSize } from "@/lib/pdf/client-precheck";
import { storageMeter } from "@/lib/admin/reports-view";
import { runStorageCleanupAction, type StorageCleanupState } from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialCleanupState: StorageCleanupState = {};

interface Bucket {
  jobs: number;
  bytes: number;
}

export interface StorageSummaryView {
  total: Bucket;
  active: Bucket;
  withinRetention: Bucket;
  cleanable: Bucket;
  cleanableByGroup: Record<"completed" | "rejected" | "failed", Bucket>;
}

const GROUP_LABELS: Record<"completed" | "rejected" | "failed", string> = {
  completed: "Printed jobs",
  rejected: "Rejected, denied, cancelled or expired jobs",
  failed: "Failed jobs",
};

const SHORT_LABELS: Record<"completed" | "rejected" | "failed", string> = {
  completed: "printed",
  rejected: "rejected",
  failed: "failed",
};

const SEGMENT_COLOR = {
  active: "bg-[var(--ink-c)]",
  kept: "bg-[var(--color-border-strong)]",
  cleanable: "bg-[var(--ink-y)]",
} as const;

const size = (bytes: number) => formatFileSize(bytes) || "0 KB";
const files = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "file" : "files"}`;
const days = (d: number) => `${d} ${d === 1 ? "day" : "days"}`;

export function StoragePanel({
  summary,
  windows,
  truncated,
}: {
  summary: StorageSummaryView;
  windows: { group: "completed" | "rejected" | "failed"; days: number }[];
  /** True when there were more jobs holding files than the page read - the
   *  totals are then a floor, and say so, rather than silently understating. */
  truncated: boolean;
}) {
  const [state, formAction, pending] = useActionState(runStorageCleanupAction, initialCleanupState);

  const meter = storageMeter({
    active: summary.active.bytes,
    withinRetention: summary.withinRetention.bytes,
    cleanable: summary.cleanable.bytes,
  });
  const counts = { active: summary.active.jobs, kept: summary.withinRetention.jobs, cleanable: summary.cleanable.jobs };
  const nothingToClean = summary.cleanable.jobs === 0;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            <HardDrive className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] text-[var(--color-muted)]">Stored now</p>
            <p className="text-3xl leading-9 font-bold tracking-[-0.02em] tabular-nums">{size(summary.total.bytes)}</p>
            <p className="text-[13px] text-[var(--color-muted)]">{files(summary.total.jobs)}</p>
          </div>
        </div>

        <div
          role="img"
          aria-label={
            meter.total === 0
              ? "No files stored"
              : meter.segments.map((s) => `${s.label}: ${s.pct}%`).join(", ")
          }
          className="mt-5 flex h-4 gap-0.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
        >
          {meter.segments
            .filter((s) => s.bytes > 0)
            .map((s) => (
              <div key={s.key} className={`h-full min-w-1.5 ${SEGMENT_COLOR[s.key]}`} style={{ flexGrow: s.bytes, flexBasis: 0 }} />
            ))}
        </div>

        <ul className="mt-4 flex flex-col gap-2.5">
          {meter.segments.map((s) => (
            <li key={s.key} className="flex items-center gap-3 text-sm">
              <span className={`h-3 w-3 shrink-0 rounded-full ${SEGMENT_COLOR[s.key]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[var(--color-text-2)]">{s.label}</span>
              <span className="text-[13px] text-[var(--color-muted)]">{files(counts[s.key])}</span>
              <span className="w-20 text-right font-medium tabular-nums">{size(s.bytes)}</span>
            </li>
          ))}
        </ul>
        {truncated && (
          <p className="mt-4 flex items-start gap-2 text-[13px] text-[var(--color-warning-ink)]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            There are more stored files than this page counts at once, so these numbers are a minimum.
          </p>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-warning-soft)] text-[var(--color-warning)]">
            <Sparkles className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base leading-6 font-semibold">Clean up</h2>
            <p className="text-sm text-[var(--color-muted)]">
              Remove files that are past their keep time. Jobs and their history stay.
            </p>
          </div>
        </div>

        <form action={formAction} className="mt-4">
          <Button
            type="submit"
            size="lg"
            variant={nothingToClean ? "secondary" : "primary"}
            pending={pending}
            pendingLabel="Cleaning up..."
            className="w-full sm:w-auto"
          >
            {nothingToClean ? "Clean up now" : `Clean up ${files(summary.cleanable.jobs)} now`}
          </Button>
        </form>

        <div aria-live="polite" className="mt-3 empty:hidden">
          <FormError message={state.error} />
          {state.success && (
            <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-success-soft)] px-3.5 py-3 text-sm text-[var(--color-success-ink)]">
              <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{state.success}</span>
            </p>
          )}
        </div>
      </Card>

      <Collapsible
        id="keep-times"
        title="How long files are kept"
        icon={<CalendarClock className="h-4 w-4" />}
        summary={windows.map((w) => `${SHORT_LABELS[w.group]} ${w.days}`).join(", ") + " days"}
      >
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Files are removed on their own after these times. The record of who printed what, and how many sheets it used, is kept.
        </p>
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {windows.map((w) => {
            const waiting = summary.cleanableByGroup[w.group];
            return (
              <li key={w.group} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-3 first:pt-0 last:pb-0">
                <span className="text-sm font-medium">{GROUP_LABELS[w.group]}</span>
                <span className="text-sm text-[var(--color-text-2)]">
                  kept {days(w.days)}
                  <span className="text-[var(--color-muted)]">
                    {" "}
                    · {waiting.jobs > 0 ? `${files(waiting.jobs)} ready to remove (${size(waiting.bytes)})` : "nothing waiting"}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Sizes are the files people sent. Booklets also store a print-ready copy that is not counted, so the real total is a little higher.
        </p>
      </Collapsible>
    </div>
  );
}
