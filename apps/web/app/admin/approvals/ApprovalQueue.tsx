"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Eye, ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/database.types";
import { Button, Input, EmptyState, FormError, Card } from "@/components/ui";
import { formatFileSize } from "@/lib/pdf/client-precheck";
import { renderPdfPageToCanvas } from "@/lib/pdf/render-page";
import { approveJobAction, createJobFileUrlAction, rejectJobAction, type ApprovalActionState } from "./actions";

type PrintJob = Tables<"print_jobs">;

export function ApprovalQueue({
  initialJobs,
  organizationId,
  submitterNames,
  printerLabels,
}: {
  initialJobs: PrintJob[];
  organizationId: string;
  /** profiles.id -> display name (or email) of whoever submitted the job. */
  submitterNames: Record<string, string>;
  /** printer_profiles.id -> its admin-facing label. */
  printerLabels: Record<string, string>;
}) {
  const router = useRouter();
  const jobs = initialJobs;

  /**
   * Live queue, per docs/architecture.md sec 15: any change to a print_jobs
   * row in this organization re-renders the page from the server, so a job
   * appears the moment it needs approval and disappears the moment any admin
   * acts on it (or it expires/is cancelled).
   *
   * Deliberately a router.refresh() rather than patching a local copy of the
   * list from the payload: the card shows facts that do NOT live on the
   * print_jobs row - who submitted it, which printer profile it targets - and
   * those are resolved server-side. Rendering the payload directly would show
   * "Unknown" for exactly the jobs that just arrived, which is when an
   * approver is most likely to be looking.
   *
   * `.subscribe()` is async - the websocket/join handshake takes a real,
   * variable amount of time, and a change landing before it completes is
   * missed entirely (no error, no replay) - the same gap that hid a job's
   * failure on the jobs pages (see JobsList.tsx/JobStatusLive.tsx). Firing
   * one router.refresh() the moment the subscription actually confirms
   * "SUBSCRIBED" re-syncs with whatever the server already has right as
   * we'd otherwise start missing live updates.
   */
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`approvals-${organizationId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "print_jobs", filter: `organization_id=eq.${organizationId}` },
        () => {
          router.refresh();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") router.refresh();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [organizationId, router]);

  if (jobs.length === 0) {
    // A calm/positive empty state, deliberately - an empty queue means the
    // approver is caught up, not that something is missing.
    return <EmptyState message="No jobs awaiting approval - you're caught up." icon={CheckCircle2} />;
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

const initialActionState: ApprovalActionState = {};

const PREVIEW_MAX_WIDTH_PX = 260;

/** The job's own print settings, as one plain-English line. */
function settingsSummary(job: PrintJob): string {
  const finishing = (job.finishing ?? {}) as { staple?: boolean; booklet?: boolean; punch?: boolean };
  const parts = [
    `${job.copies} ${job.copies === 1 ? "copy" : "copies"}`,
    job.color_mode === "color" ? "Color" : "Black & white",
    job.duplex ? "Double-sided" : "Single-sided",
    job.paper_size,
  ];
  if (finishing.staple) parts.push("Staple");
  if (finishing.booklet) parts.push("Booklet");
  if (finishing.punch) parts.push("Hole punch");
  return parts.join(" • ");
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
  const [showReject, setShowReject] = useState(false);

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
        if (!ok) setPreviewError("This file couldn't be rendered here - open the original to view it.");
      }
    } catch {
      setPreviewError("This file couldn't be rendered here - open the original to view it.");
    } finally {
      setPreviewPending(false);
    }
  }

  return (
    <li>
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium">{job.original_file_name}</span>
          <span className="shrink-0 text-xs text-[var(--color-muted)]">{job.job_number}</span>
        </div>

        <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          <Detail label="Submitted by" value={submitterName ?? "Unknown"} />
          <Detail label="Pages" value={`${job.source_pdf_pages}`} />
          <Detail label="File size" value={formatFileSize(Number(job.file_size_bytes))} />
          <Detail label="Sheets" value={`${job.estimated_physical_sheets}`} />
          <Detail label="Printer" value={printerLabel ?? "—"} />
          {/* The settings line is the one detail that must never be clipped -
           *  "Color" or "Staple" disappearing behind an ellipsis is exactly
           *  the sort of thing an approver is deciding on. */}
          <Detail label="Settings" value={settingsSummary(job)} className="col-span-2 sm:col-span-3" wrap />
        </dl>

        {job.policy_reasons.length > 0 && (
          <div className="mb-3 text-sm">
            <p className="font-medium">Reason:</p>
            <ul className="list-inside list-disc text-[var(--color-muted)]">
              {job.policy_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        <div hidden={previewOpen}>
          <Button type="button" variant="outline" size="sm" onClick={openPreview}>
            <span className="flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5" />
              View file
            </span>
          </Button>
        </div>

        {/* Always mounted (just hidden until asked for) so the canvas ref is
         *  available the moment the signed URL comes back - no render-order
         *  race with the async draw, same as the submitter's own preview in
         *  app/(dashboard)/print/PrintForm.tsx. */}
        <div className="mb-3 flex items-start gap-4" hidden={!previewOpen}>
          <div className="flex min-h-[140px] w-[140px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-gray-50">
            {previewPending && <span className="text-xs text-[var(--color-muted)]">Loading…</span>}
            <canvas ref={canvasRef} className="max-h-full max-w-full" hidden={!previewRendered} />
            {!previewPending && !previewRendered && (
              <span className="px-2 text-center text-[10px] text-[var(--color-muted)]">No preview</span>
            )}
          </div>
          <div className="min-w-0 text-sm">
            <p className="text-[var(--color-muted)]">First page of the submitted document.</p>
            {fileUrl && (
              <>
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 text-[var(--color-primary)] underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open the original PDF
                </a>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  This link is private to you and stops working after a couple of minutes - reopen the preview to get a
                  fresh one.
                </p>
              </>
            )}
            {previewError && <p className="mt-1 text-xs text-[var(--color-danger)]">{previewError}</p>}
          </div>
        </div>

        <FormError message={approveState.error ?? rejectState.error} />

        {showReject ? (
          <form action={rejectAction} className="mt-2 flex flex-col gap-2">
            <input type="hidden" name="jobId" value={job.id} />
            <Input name="reason" placeholder="Reason (optional)" />
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowReject(false)}>
                Back
              </Button>
              <Button type="submit" variant="danger" size="sm" pending={rejectPending} pendingLabel="Rejecting...">
                Confirm reject
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="outline-danger" size="sm" onClick={() => setShowReject(true)}>
              Reject
            </Button>
            <form action={approveAction}>
              <input type="hidden" name="jobId" value={job.id} />
              <Button type="submit" variant="success" size="sm" pending={approvePending} pendingLabel="Approving...">
                Approve
              </Button>
            </form>
          </div>
        )}
      </Card>
    </li>
  );
}

function Detail({
  label,
  value,
  className,
  wrap = false,
}: {
  label: string;
  value: string;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className={`font-medium ${wrap ? "" : "truncate"}`}>{value}</dd>
    </div>
  );
}
