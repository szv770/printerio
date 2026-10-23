"use client";

import { useActionState, useRef, useState } from "react";
import { CheckCircle2, Check, ExternalLink, Eye, FileText, X } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, EmptyState, FormError, Input } from "@/components/ui";
import { LocalTime } from "@/app/(dashboard)/jobs/LocalTime";
import { formatFileSize } from "@/lib/pdf/client-precheck";
import { renderPdfPageToCanvas } from "@/lib/pdf/render-page";
import { approveJobAction, createJobFileUrlAction, rejectJobAction, type ApprovalActionState } from "./actions";

type PrintJob = Tables<"print_jobs">;

const initialActionState: ApprovalActionState = {};
const PREVIEW_MAX_WIDTH_PX = 260;

/** What the list of waiting jobs looks like. No data fetching here: ApprovalQueue (live) and the dev preview both render it. */
export function ApprovalList({
  jobs,
  submitterNames,
  printerLabels,
}: {
  jobs: PrintJob[];
  /** profiles.id -> display name (or email) of whoever submitted the job. */
  submitterNames: Record<string, string>;
  /** printer_profiles.id -> its admin-facing label. */
  printerLabels: Record<string, string>;
}) {
  if (jobs.length === 0) {
    // A calm, positive empty state: an empty queue means the approver is caught up.
    return <EmptyState icon={CheckCircle2} title="Nothing waiting for you." description="New jobs that need a yes or no will show up here." />;
  }

  return (
    <ul className="flex flex-col gap-4" data-tour="admin-approvals-queue">
      {jobs.map((job) => (
        <ApprovalCard
          key={job.id}
          job={job}
          submitterName={submitterNames[job.created_by] ?? null}
          printerLabel={job.printer_profile_id ? (printerLabels[job.printer_profile_id] ?? null) : null}
        />
      ))}
    </ul>
  );
}

/** The job's own print choices as short chips, so nothing an approver decides on is hidden. */
function chipsFor(job: PrintJob, printerLabel: string | null): string[] {
  const finishing = (job.finishing ?? {}) as { staple?: boolean; booklet?: boolean; punch?: boolean };
  const chips = [
    `${job.source_pdf_pages} ${job.source_pdf_pages === 1 ? "page" : "pages"}`,
    `${job.copies} ${job.copies === 1 ? "copy" : "copies"}`,
    job.color_mode === "color" ? "Color" : "Black and white",
    job.duplex ? "Double-sided" : "Single-sided",
    job.paper_size,
    `${job.estimated_physical_sheets} ${job.estimated_physical_sheets === 1 ? "sheet" : "sheets"}`,
  ];
  if (finishing.staple) chips.push("Staple");
  if (finishing.booklet) chips.push("Booklet");
  if (finishing.punch) chips.push("Hole punch");
  if (printerLabel) chips.push(printerLabel);
  return chips;
}

function ApprovalCard({
  job,
  submitterName,
  printerLabel,
}: {
  job: PrintJob;
  submitterName: string | null;
  printerLabel: string | null;
}) {
  const [approveState, approveAction, approvePending] = useActionState(approveJobAction, initialActionState);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectJobAction, initialActionState);
  const [confirmReject, setConfirmReject] = useState(false);

  // Preview state. Nothing is fetched until the approver asks for it - the
  // queue must stay cheap to open when there are a dozen pending jobs, and a
  // signed URL that is never used should never be minted at all.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [previewRendered, setPreviewRendered] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  async function openPreview() {
    setPreviewOpen(true);
    if (fileUrl || previewPending) return; // already fetched (or in flight)
    setPreviewPending(true);
    setPreviewError(null);

    const result = await createJobFileUrlAction(job.id);
    if (result.error || !result.url) {
      setPreviewPending(false);
      setPreviewError(result.error ?? "Could not open this file.");
      return;
    }
    setFileUrl(result.url);

    // Render page 1 in the browser from the same short-lived signed URL that
    // backs the "Open original" link - no second grant, no server-side
    // rasterizer, and the bytes never touch this app's own server.
    try {
      const response = await fetch(result.url);
      if (!response.ok) throw new Error("download failed");
      const bytes = await response.arrayBuffer();
      if (canvasRef.current) {
        const ok = await renderPdfPageToCanvas(bytes, canvasRef.current, { maxWidthPx: PREVIEW_MAX_WIDTH_PX });
        setPreviewRendered(ok);
        if (!ok) setPreviewError("This file couldn't be shown here. Open the original to view it.");
      }
    } catch {
      setPreviewError("This file couldn't be shown here. Open the original to view it.");
    } finally {
      setPreviewPending(false);
    }
  }

  const who = submitterName ?? "Unknown user";
  const error = approveState.error ?? rejectState.error;

  return (
    <li className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
      {/* The yellow edge is the "waiting" ink colour used for waiting states everywhere. */}
      <div className="h-1.5 bg-[var(--ink-y)]" aria-hidden="true" />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-base font-semibold text-[var(--color-primary-hover)]"
          >
            {who.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[17px] leading-6 font-semibold">{who}</p>
            <p className="text-[13px] text-[var(--color-muted)]">
              Sent <LocalTime iso={job.created_at} />
            </p>
          </div>
          <span className="shrink-0 text-xs text-[var(--color-faint)]">{job.job_number}</span>
        </div>

        <div className="flex items-start gap-3 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-3.5 py-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-base leading-6 font-medium break-words">{job.original_file_name}</p>
            <p className="text-[13px] text-[var(--color-muted)]">{formatFileSize(Number(job.file_size_bytes))}</p>
          </div>
        </div>

        <ul className="flex flex-wrap gap-1.5" aria-label="Print choices">
          {chipsFor(job, printerLabel).map((c) => (
            <li
              key={c}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[13px] leading-4 text-[var(--color-text-2)]"
            >
              {c}
            </li>
          ))}
        </ul>

        {job.policy_reasons.length > 0 && (
          <div className="rounded-[var(--radius-control)] bg-[var(--color-warning-soft)] px-3.5 py-3 text-sm text-[var(--color-warning-ink)]">
            <p className="font-medium">Why it needs approval</p>
            <ul className="mt-1 list-inside list-disc">
              {job.policy_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        <div hidden={previewOpen}>
          <Button type="button" variant="secondary" onClick={openPreview} className="w-full sm:w-auto">
            <Eye className="h-4 w-4" aria-hidden="true" />
            Preview file
          </Button>
        </div>

        {/* Always mounted (just hidden until asked for) so the canvas ref is
         *  available the moment the signed URL comes back - no render-order
         *  race with the async draw, same as the submitter's own preview in
         *  app/(dashboard)/print/PrintForm.tsx. */}
        <div className="flex items-start gap-4" hidden={!previewOpen}>
          <div className="flex min-h-[140px] w-[140px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]">
            {previewPending && <span className="text-xs text-[var(--color-muted)]">Loading...</span>}
            <canvas ref={canvasRef} className="max-h-full max-w-full" hidden={!previewRendered} />
            {!previewPending && !previewRendered && (
              <span className="px-2 text-center text-[11px] text-[var(--color-muted)]">No preview</span>
            )}
          </div>
          <div className="min-w-0 text-sm">
            <p className="text-[var(--color-muted)]">First page of the document.</p>
            {fileUrl && (
              <>
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex min-h-11 items-center gap-1.5 font-medium text-[var(--color-primary)] hover:underline"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Open the whole file
                </a>
                <p className="text-xs text-[var(--color-muted)]">This link stops working after a couple of minutes. Preview again for a fresh one.</p>
              </>
            )}
            {previewError && <p className="mt-1 text-xs text-[var(--color-danger)]">{previewError}</p>}
          </div>
        </div>

        <FormError message={error} />

        {confirmReject ? (
          <form
            action={rejectAction}
            className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3.5"
          >
            <input type="hidden" name="jobId" value={job.id} />
            <p className="text-sm font-medium text-[var(--color-danger-ink)]">Reject this job? It will not print.</p>
            <Input name="reason" placeholder="Reason (optional)" aria-label="Reason for rejecting (optional)" />
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="secondary" size="lg" onClick={() => setConfirmReject(false)}>
                Keep it
              </Button>
              <Button type="submit" variant="danger" size="lg" pending={rejectPending} pendingLabel="Rejecting...">
                <X className="h-4 w-4" aria-hidden="true" />
                Reject
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline-danger" size="lg" onClick={() => setConfirmReject(true)}>
              <X className="h-4 w-4" aria-hidden="true" />
              Reject
            </Button>
            <form action={approveAction} className="contents">
              <input type="hidden" name="jobId" value={job.id} />
              <Button type="submit" variant="success" size="lg" pending={approvePending} pendingLabel="Approving...">
                <Check className="h-4 w-4" aria-hidden="true" />
                Approve
              </Button>
            </form>
          </div>
        )}
      </div>
    </li>
  );
}
