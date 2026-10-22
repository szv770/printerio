"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireOrgRole } from "@/lib/auth/session";
import { adjustMonthlyUsage, usageAmountsForJob } from "@/lib/quota";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

export interface ApprovalActionState {
  error?: string;
}

export interface JobFileUrlState {
  error?: string;
  /** Short-lived Supabase Storage signed URL for the job's ORIGINAL upload. */
  url?: string;
  expiresInSeconds?: number;
}

/** Matches the "2 minutes for browser preview" figure documented in
 *  docs/architecture.md sec 3.3. Storage signed URLs cannot be revoked early
 *  (docs/known-limitations.md), so the expiry is the whole control - it is
 *  deliberately much shorter than the Agent's own 5-minute download window,
 *  which has a large file to pull over a school connection and this does not. */
const PREVIEW_URL_TTL_SECONDS = 120;

/**
 * Mints a short-lived signed URL so an approver can look at the actual
 * document before deciding, rather than approving a filename and a page
 * count. Never a public URL, and never a URL for a file outside the caller's
 * own organization:
 *
 *  - `requireOrgRole(["org_admin", "approver"])` is the role gate.
 *  - the job row is read through the RLS-governed client (print_jobs' select
 *    policy already limits an approver to their own org's jobs) and its
 *    organization_id is then re-checked against the caller's own membership,
 *    so a guessed job id from another organization returns "not found" twice
 *    over.
 *  - the signed URL is minted with the service-role client AFTER those two
 *    checks (migration 0034 removes members' direct Storage access), and the
 *    path comes from the verified row, never from the client.
 */
export async function createJobFileUrlAction(jobId: string): Promise<JobFileUrlState> {
  const session = await requireOrgRole(["org_admin", "approver"]);

  const supabase = await createClient();
  const { data: job, error } = await supabase
    .from("print_jobs")
    .select("id, organization_id, original_file_path, files_purged_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error || !job || job.organization_id !== session.membership.organization_id) {
    return { error: "Job not found." };
  }
  if (job.files_purged_at) {
    return { error: "This job's file has already been deleted under the organization's retention policy." };
  }

  const { data: signed, error: signError } = await createServiceRoleClient()
    .storage.from(PRINT_JOBS_BUCKET)
    .createSignedUrl(job.original_file_path, PREVIEW_URL_TTL_SECONDS);
  if (signError || !signed) {
    logger.error("failed to sign a job file URL for an approver", {
      jobId,
      organizationId: job.organization_id,
      error: signError?.message,
    });
    return { error: "Could not open this file right now. Try again in a moment." };
  }

  return { url: signed.signedUrl, expiresInSeconds: PREVIEW_URL_TTL_SECONDS };
}

async function loadPendingJob(jobId: string, organizationId: string) {
  const supabase = await createClient();
  const { data: job, error } = await supabase.from("print_jobs").select("*").eq("id", jobId).single();
  if (error || !job) throw new Error("Job not found");
  if (job.organization_id !== organizationId) throw new Error("Job belongs to a different organization");
  if (job.status !== "pending_approval") throw new Error(NOT_PENDING);
  return { job };
}

const NOT_PENDING = "Job is no longer awaiting approval";

/**
 * The one write both decisions share. Runs as service-role (members and approvers have no UPDATE on print_jobs
 * after migration 0034), so the authorization is the WHERE clause: this organization, still pending_approval. A
 * second approver, or the expiry sweep, getting there first leaves zero rows and the caller stops without
 * recording a decision or touching quota.
 */
async function decide(jobId: string, organizationId: string, patch: { status: "approved" | "rejected"; approved_at?: string; approved_by?: string }) {
  const { data, error } = await createServiceRoleClient()
    .from("print_jobs")
    .update(patch)
    .eq("id", jobId)
    .eq("organization_id", organizationId)
    .eq("status", "pending_approval")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(NOT_PENDING);
}

export async function approveJobAction(_prev: ApprovalActionState, formData: FormData): Promise<ApprovalActionState> {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const jobId = String(formData.get("jobId") ?? "");

  try {
    const { job } = await loadPendingJob(jobId, session.membership.organization_id);
    const service = createServiceRoleClient();

    await decide(jobId, session.membership.organization_id, {
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: session.userId,
    });

    await service.from("approval_actions").insert({ job_id: jobId, approver_id: session.userId, decision: "approved" });
    await service.from("print_job_events").insert({
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
    const { job } = await loadPendingJob(jobId, session.membership.organization_id);
    const service = createServiceRoleClient();

    await decide(jobId, session.membership.organization_id, { status: "rejected" });

    await service
      .from("approval_actions")
      .insert({ job_id: jobId, approver_id: session.userId, decision: "rejected", reason });
    await service.from("print_job_events").insert({
      job_id: jobId,
      event_type: "REJECTED",
      actor_type: "admin",
      actor_id: session.userId,
      metadata: reason ? { reason } : {},
    });

    // Release the quota reservation made at submission time - this job will
    // never print, so the submitter must not stay charged for it.
    //
    // Service-role (as is every write in this file now).
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
