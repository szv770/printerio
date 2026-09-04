"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { adjustMonthlyUsage } from "@/lib/quota";

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
    revalidatePath("/admin/approvals");
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

    // Release the quota reservation made at submission time - this job will never print.
    const colorWeight = job.color_mode === "color" ? 2 : 1;
    await adjustMonthlyUsage(
      supabase,
      { organizationId: job.organization_id, userId: job.created_by },
      {
        pdfPages: job.source_pdf_pages * job.copies,
        printedSides: job.estimated_printed_sides,
        physicalSheets: job.estimated_physical_sheets,
        colorWeighted: job.estimated_physical_sheets * colorWeight,
      },
      "physical_sheets", // basis/limit are unused by the RPC's release path
      null,
      "release",
    );

    revalidatePath("/admin/approvals");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to reject job" };
  }
}
