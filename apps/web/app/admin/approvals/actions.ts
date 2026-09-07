"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireOrgRole } from "@/lib/auth/session";
import { adjustMonthlyUsage, usageAmountsForJob } from "@/lib/quota";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

export interface ApprovalActionState {
  error?: string;
}

async function loadPendingJob(jobId: string, organizationId: string) {
  const supabase = await createClient();
  const { data: job, error } = await supabase.from("print_jobs").select("*").eq("id", jobId).single();
  if (error || !job) throw new Error("Job not found");
  if (job.organization_id !== organizationId) throw new Error("Job belongs to a different organization");
  if (job.status !== "pending_approval") throw new Error("Job is no longer awaiting approval");
  return { supabase, job };
}

export async function approveJobAction(_prev: ApprovalActionState, formData: FormData): Promise<ApprovalActionState> {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const jobId = String(formData.get("jobId") ?? "");

  try {
    const { supabase, job } = await loadPendingJob(jobId, session.membership.organization_id);

    const { error: updateError } = await supabase
      .from("print_jobs")
      .update({ status: "approved", approved_at: new Date().toISOString(), approved_by: session.userId })
      .eq("id", jobId);
    if (updateError) throw updateError;

    await supabase.from("approval_actions").insert({ job_id: jobId, approver_id: session.userId, decision: "approved" });
    await supabase.from("print_job_events").insert({
      job_id: jobId,
      event_type: "APPROVED",
      actor_type: "admin",
      actor_id: session.userId,
    });

    void job; // reservation already made at submission time; nothing to release on approval.
    revalidatePath(routes.adminApprovals);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to approve job" };
  }
}

export async function rejectJobAction(_prev: ApprovalActionState, formData: FormData): Promise<ApprovalActionState> {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const jobId = String(formData.get("jobId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  try {
    const { supabase, job } = await loadPendingJob(jobId, session.membership.organization_id);

    const { error: updateError } = await supabase.from("print_jobs").update({ status: "rejected" }).eq("id", jobId);
    if (updateError) throw updateError;

    await supabase
      .from("approval_actions")
      .insert({ job_id: jobId, approver_id: session.userId, decision: "rejected", reason });
    await supabase.from("print_job_events").insert({
      job_id: jobId,
      event_type: "REJECTED",
      actor_type: "admin",
      actor_id: session.userId,
      metadata: reason ? { reason } : {},
    });

    // Release the quota reservation made at submission time - this job will
    // never print, so the submitter must not stay charged for it.
    //
    // Deliberately service-role, unlike everything else in this action.
    // adjust_monthly_usage is SECURITY INVOKER (0010_quota_functions.sql) and
    // monthly_usage's UPDATE policy only admits `user_id = auth.uid()` or
    // private.is_org_admin(...) - while THIS action is open to `approver` too
    // (private.is_org_approver, which print_jobs' own policy uses). An
    // approver rejecting someone else's job therefore matched zero rows, and
    // because the RPC's release path unconditionally returns true, the
    // submitter was silently left holding the reservation for a job that was
    // rejected. The same release already runs as service-role from the Agent
    // status route and the cron sweep; this path was the outlier.
    //
    // Safe by construction: nothing here comes from the client. The job row
    // was read server-side and verified to belong to this caller's own
    // organization and to still be pending_approval (loadPendingJob), the
    // caller passed requireOrgRole(["org_admin", "approver"]), and `release`
    // only ever decreases a reservation - it can never grant quota.
    try {
      await adjustMonthlyUsage(
        createServiceRoleClient(),
        { organizationId: job.organization_id, userId: job.created_by },
        usageAmountsForJob({
          organizationId: job.organization_id,
          userId: job.created_by,
          sourcePdfPages: job.source_pdf_pages,
          copies: job.copies,
          estimatedPrintedSides: job.estimated_printed_sides,
          estimatedPhysicalSheets: job.estimated_physical_sheets,
          colorMode: job.color_mode,
        }),
        "physical_sheets", // basis/limit are unused by the RPC's release path
        null,
        "release",
      );
    } catch (releaseError) {
      // The rejection itself already committed and is what the approver is
      // waiting on - don't fail it back to them over the refund. Log loudly:
      // a reservation left behind here overstates the submitter's usage until
      // the next month rolls over.
      logger.error("failed to release the quota reservation for a rejected job", {
        jobId,
        organizationId: job.organization_id,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }

    revalidatePath(routes.adminApprovals);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to reject job" };
  }
}
