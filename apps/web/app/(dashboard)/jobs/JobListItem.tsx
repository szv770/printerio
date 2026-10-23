import Link from "next/link";
import { FileCheck2, FileText } from "lucide-react";
import { routes } from "@/lib/routes";
import { Badge } from "@/components/ui";
import { jobAttentionLine } from "@/lib/job-progress";
import { jobWaitingLine } from "@/lib/job-waiting";
import { ReprintButton } from "./[id]/ReprintButton";
import { CancelJobButton } from "./[id]/CancelJobButton";
import { JobStatusBadge } from "./JobStatusBadge";
import { JobProgressBar } from "./JobProgressBar";
import { LocalTime } from "./LocalTime";
import type { JobRow } from "./JobsList";

/**
 * One job in the "My jobs" list. Purely presentational (no data access) so the
 * dev preview can render it with sample rows. Phone layout: file name + status
 * on top, one quiet meta line, progress, then actions on their own row so the
 * tap targets are never squeezed beside the text.
 */
export function JobListItem({ job, eventTypes }: { job: JobRow; eventTypes?: string[] }) {
  const attention = jobAttentionLine({
    status: job.status,
    errorMessage: job.error_message,
    policyReasons: job.policy_reasons,
    heldReason: job.held_reason,
  });
  const waitingLine = jobWaitingLine({ status: job.status, errorMessage: job.error_message });
  const canCancel = ["held", "pending_approval", "approved", "failed"].includes(job.status);
  // Reprinting re-runs the ordinary pipeline (policy + quota), so it is not
  // offered for a test print - see the job detail page for the same reasoning.
  const showReprint = !job.is_test_print && !job.files_purged_at;
  const hasActions = canCancel || showReprint;
  return (
    <li className="group rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-xs)]">
      <Link
        href={routes.job(job.id)}
        className="block rounded-[var(--radius-card)] p-4 focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:p-5"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[var(--color-muted)] sm:flex">
            <FileText className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 truncate text-[15px] font-medium leading-6">{job.original_file_name}</span>
              <span className="shrink-0">
                <JobStatusBadge status={job.status} errorMessage={job.error_message} />
              </span>
            </div>
            <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-muted)]">
              {job.source_pdf_pages} {job.source_pdf_pages === 1 ? "page" : "pages"} · {job.color_mode === "color" ? "Color" : "Black & white"} ·{" "}
              {job.duplex ? "Double-sided" : "Single-sided"} · {job.copies} {job.copies === 1 ? "copy" : "copies"}
            </p>
            <p className="text-xs leading-5 text-[var(--color-faint)]">
              {job.job_number} · <LocalTime iso={job.created_at} />
              {job.is_test_print && (
                <span className="ml-2 inline-flex translate-y-px">
                  <Badge tone="neutral">
                    <span className="flex items-center gap-1">
                      <FileCheck2 className="h-3 w-3" aria-hidden="true" /> Test print
                    </span>
                  </Badge>
                </span>
              )}
            </p>
            <div className="mt-3">
              <JobProgressBar
                status={job.status}
                policyAction={job.policy_action}
                eventTypes={eventTypes}
                isTestPrint={job.is_test_print}
              />
            </div>
            {waitingLine && (
              <p className="mt-2 text-[13px] leading-5 text-[var(--color-warning)]">{waitingLine}</p>
            )}
            {attention && (
              <p
                className={`mt-2 text-[13px] leading-5 ${
                  job.status === "held" ? "text-[var(--color-warning)]" : "text-[var(--color-danger)]"
                }`}
              >
                {attention}
              </p>
            )}
          </div>
        </div>
      </Link>
      {(hasActions || job.files_purged_at) && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2.5 sm:px-5">
          {job.files_purged_at && !job.is_test_print && (
            <p className="mr-auto text-xs text-[var(--color-muted)]">
              File removed after a few days. To print again, upload the original.
            </p>
          )}
          {canCancel && <CancelJobButton jobId={job.id} compact />}
          {showReprint && <ReprintButton jobId={job.id} />}
        </div>
      )}
    </li>
  );
}
