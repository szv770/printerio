"use client";

import { useActionState, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/database.types";
import { Button, Input, EmptyState, FormError, Card } from "@/components/ui";
import { approveJobAction, rejectJobAction, type ApprovalActionState } from "./actions";

type PrintJob = Tables<"print_jobs">;

export function ApprovalQueue({ initialJobs, organizationId }: { initialJobs: PrintJob[]; organizationId: string }) {
  const [jobs, setJobs] = useState(initialJobs);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`approvals-${organizationId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "print_jobs", filter: `organization_id=eq.${organizationId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as PrintJob;
          setJobs((prev) => {
            const withoutRow = prev.filter((j) => j.id !== row.id);
            // A job only belongs in this queue while it is pending_approval -
            // it disappears the instant a decision (or expiry/cancel) changes
            // its status away from that, per docs/architecture.md sec 15.
            if (payload.eventType !== "DELETE" && (payload.new as PrintJob).status === "pending_approval") {
              return [...withoutRow, payload.new as PrintJob].sort(
                (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
              );
            }
            return withoutRow;
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [organizationId]);

  if (jobs.length === 0) {
    // A calm/positive empty state, deliberately - an empty queue means the
    // approver is caught up, not that something is missing.
    return <EmptyState message="No jobs awaiting approval - you're caught up." icon={CheckCircle2} />;
  }

  return (
    <ul className="flex flex-col gap-4" data-tour="admin-approvals-queue">
      {jobs.map((job) => (
        <ApprovalCard key={job.id} job={job} />
      ))}
    </ul>
  );
}

const initialActionState: ApprovalActionState = {};

function ApprovalCard({ job }: { job: PrintJob }) {
  const [approveState, approveAction, approvePending] = useActionState(approveJobAction, initialActionState);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectJobAction, initialActionState);
  const [showReject, setShowReject] = useState(false);

  return (
    <li>
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">{job.original_file_name}</span>
          <span className="text-xs text-[var(--color-muted)]">{job.job_number}</span>
        </div>
        <p className="mb-2 text-sm text-[var(--color-muted)]">
          {job.source_pdf_pages} pages • {job.color_mode === "color" ? "Color" : "B&W"} • {job.copies}{" "}
          {job.copies === 1 ? "copy" : "copies"}
          {job.duplex ? " • Duplex" : ""}
        </p>
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
