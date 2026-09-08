"use client";

import { useActionState } from "react";
import { HardDrive, Trash2 } from "lucide-react";
import { Button, Card, FormError, FormSuccess } from "@/components/ui";
import { formatFileSize } from "@/lib/pdf/client-precheck";
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

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Stored now" value={formatFileSize(summary.total.bytes) || "0 KB"} sub={`${summary.total.jobs} files`} />
        <Stat
          label="Ready to clean up"
          value={formatFileSize(summary.cleanable.bytes) || "0 KB"}
          sub={`${summary.cleanable.jobs} files past their retention window`}
        />
        <Stat
          label="Still in use"
          value={formatFileSize(summary.active.bytes) || "0 KB"}
          sub={`${summary.active.jobs} jobs not finished yet`}
        />
      </div>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">What is being kept, and for how long</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Printio keeps a job&apos;s uploaded PDF only as long as your retention settings say, then deletes it
          automatically. The job itself - who printed what, when, and how many sheets it used - is kept either way, so
          deleting files never costs you any history or reporting.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {windows.map((w) => (
            <li key={w.group} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {GROUP_LABELS[w.group]} — files kept {w.days} {w.days === 1 ? "day" : "days"}
              </span>
              <span className="text-[var(--color-muted)]">
                {summary.cleanableByGroup[w.group].jobs > 0
                  ? `${summary.cleanableByGroup[w.group].jobs} ready to remove (${formatFileSize(summary.cleanableByGroup[w.group].bytes) || "0 KB"})`
                  : "nothing waiting"}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Sizes are the uploaded originals. A booklet job also stores a generated print-ready copy, whose size
          isn&apos;t recorded, so the real total is a little higher than shown.
          {truncated ? " This organization has more stored files than this page reads at once, so these totals are a floor." : ""}
        </p>
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Clean up now</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Runs the same automatic cleanup immediately instead of waiting for the next scheduled pass. It removes only
          the files already past their retention window above - nothing belonging to a job that is still waiting,
          printing, or inside its window - and never deletes a job record.
        </p>

        <FormError message={state.error} />
        <FormSuccess message={state.success} />

        <form action={formAction} className="mt-2">
          <Button type="submit" variant="outline" pending={pending} pendingLabel="Cleaning up...">
            {summary.cleanable.jobs > 0
              ? `Clean up ${summary.cleanable.jobs} ${summary.cleanable.jobs === 1 ? "file" : "files"} now`
              : "Clean up now"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{sub}</p>
    </Card>
  );
}
