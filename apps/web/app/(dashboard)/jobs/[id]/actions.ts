"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { canOwnerPurgeFiles, purgeJobFiles } from "@/lib/retention";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";
import { cancelOwnJob, retryOwnJob, type JobActionResult } from "@/lib/jobs/lifecycle";

export interface DeleteJobFileState {
  error?: string;
  success?: string;
}

/**
 * Deletes the stored copy of a finished job's PDF straight away, instead of
 * waiting out the organization's retention window.
 *
 * What this deliberately does NOT do: touch the print_jobs row. The job, its
 * number, its page/sheet counts, its policy decision and its whole
 * print_job_events trail all survive - the audit trail must outlive the file
 * (docs/architecture.md sec 16), and there is no delete policy on print_jobs
 * for any user role precisely so nobody can erase their own history by
 * "deleting" a job. This removes bytes from Storage, nothing else.
 *
 * Authorization, all re-derived server-side and never from the form:
 *  - `requireSession()` establishes who is calling;
 *  - the job row is read through the RLS-governed client AND filtered by
 *    `created_by = <caller>` and their own organization, so another person's
 *    job id simply returns "not found";
 *  - `canOwnerPurgeFiles` (pure, unit-tested in lib/retention.test.ts)
 *    re-checks the live row's state: only a genuinely terminal job qualifies,
 *    and a `failed` job only once its retries are exhausted, so this can
 *    never pull a file out from under an Agent that is about to print it.
 *
 * The removal itself goes through the service-role client because Storage's
 * delete policy (0007_storage.sql) admits only org_admins - a student
 * deleting their own file is exactly the case that policy does not cover.
 * That is safe here because nothing about *which* paths get removed comes
 * from the client: the paths are read off the verified row, and they are
 * passed to the same purgeJobFiles() the retention sweep itself uses, so
 * there is one deletion path rather than a second, looser one.
 */
export async function deleteJobFileAction(
  _prev: DeleteJobFileState,
  formData: FormData,
): Promise<DeleteJobFileState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "You are not a member of any organization yet." };

  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return { error: "Missing job." };

  const supabase = await createClient();
  const { data: job, error } = await supabase
    .from("print_jobs")
    .select("id, organization_id, status, attempt_count, max_attempts, files_purged_at, original_file_path, derived_file_path")
    .eq("id", jobId)
    .eq("created_by", session.userId)
    .eq("organization_id", session.membership.organization_id)
    .maybeSingle();
  if (error || !job) return { error: "Job not found." };

  const allowed = canOwnerPurgeFiles(job);
  if (!allowed.ok) return { error: allowed.reason };

  const result = await purgeJobFiles(createServiceRoleClient(), [job], new Date().toISOString());
  if (result.jobsPurged === 0) {
    logger.error("user-requested file deletion removed nothing", { jobId, organizationId: job.organization_id });
    return { error: "Couldn't delete the file right now. Try again in a moment." };
  }

  revalidatePath(routes.job(jobId));
  return { success: "Deleted. The job and its history are still here - only the stored file is gone." };
}

export interface JobActionState {
  error?: string;
  success?: string;
}

/**
 * Cancel / "Try again" for the person who submitted the job. Thin on purpose: who may do what, and the status/quota
 * rules, live in lib/jobs/lifecycle.ts (unit-tested). Authorization is re-derived here from the session - the job
 * id is the only thing taken from the form - and the writes use the SERVICE-ROLE client (members have no UPDATE on
 * print_jobs, migration 0034), guarded in the WHERE clause on this owner, this organization and the exact status.
 */
async function ownerAction(
  formData: FormData,
  run: (service: ReturnType<typeof createServiceRoleClient>, ref: { jobId: string; userId: string; organizationId: string }) => Promise<JobActionResult>,
  what: string,
): Promise<JobActionState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "You are not a member of any organization yet." };
  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return { error: "Missing job." };

  try {
    const result = await run(createServiceRoleClient(), {
      jobId,
      userId: session.userId,
      organizationId: session.membership.organization_id,
    });
    revalidatePath(routes.job(jobId));
    revalidatePath(routes.jobs);
    return result.ok ? { success: result.message } : { error: result.error };
  } catch (err) {
    logger.error(`${what} failed unexpectedly`, { jobId, error: err instanceof Error ? err.message : String(err) });
    return { error: `Could not ${what} right now. Try again in a moment.` };
  }
}

export async function cancelJobAction(_prev: JobActionState, formData: FormData): Promise<JobActionState> {
  return ownerAction(formData, cancelOwnJob, "cancel this job");
}

export async function retryJobAction(_prev: JobActionState, formData: FormData): Promise<JobActionState> {
  return ownerAction(formData, retryOwnJob, "try this job again");
}
