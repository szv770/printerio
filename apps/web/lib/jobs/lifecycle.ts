import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { adjustMonthlyUsage, usageAmountsForJob } from "@/lib/quota";
import { logger } from "@/lib/logger";

/**
 * Owner-initiated cancel / retry and the shared "re-queue a failed job" step.
 *
 * EVERY write here is meant to be made with the SERVICE-ROLE client (members have no UPDATE on print_jobs and no
 * EXECUTE on adjust_monthly_usage from migration 0034), so the authorization is explicit in code and in the WHERE
 * clause of each write: this job id, this owner, this organization, and the exact status the decision was based
 * on. A double click, or a race with the print agent or the sweep, therefore matches zero rows and does nothing -
 * in particular it cannot release a quota reservation twice (release works on the owner's shared monthly row).
 *
 * QUOTA ACCOUNTING RULES (one reservation per job, made at submission):
 *   - pending_approval, approved: the job holds its reservation.
 *   - held: reserves nothing (the reservation is made when it is released into the pipeline).
 *   - claimed .. submitted_to_spooler: still held; converted to usage on completed.
 *   - failed with attempts left (attempt_count < max_attempts): STILL HELD, because the job can be retried
 *     (manually, or automatically if the organization enabled it). A retry re-uses that reservation and never
 *     reserves again.
 *   - released exactly once when the job is finally abandoned: cancelled by its owner (or swept), or its last
 *     attempt fails (status route / sweep). A failed job with NO attempts left already released at that point,
 *     so cancelling it must not release again.
 *   - test prints never reserved anything and never release.
 */

type Client = SupabaseClient<Database>;

export const GONE_TO_PRINTER = "This job has already gone to the printer. Clear it at the printer.";

export type JobActionResult = { ok: true; message: string } | { ok: false; error: string };

export interface OwnerRef {
  jobId: string;
  userId: string;
  organizationId: string;
}

/** Statuses an owner may cancel from: nothing has been sent to the agent yet (a failed job is abandoned). */
const CANCELLABLE = ["held", "pending_approval", "approved", "failed"] as const;
/** The agent has (or may have) the job, or it is at the printer: the raw job cannot be recalled. */
const WITH_AGENT = ["claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"] as const;

const JOB_COLUMNS =
  "id, organization_id, created_by, status, attempt_count, max_attempts, is_test_print, files_purged_at, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode";

interface JobFacts {
  id: string;
  organization_id: string;
  created_by: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  is_test_print: boolean;
  files_purged_at: string | null;
  source_pdf_pages: number;
  copies: number;
  estimated_printed_sides: number;
  estimated_physical_sheets: number;
  color_mode: string;
}

/** True when this job currently holds a quota reservation (see the rules above). */
export function holdsReservation(job: Pick<JobFacts, "status" | "attempt_count" | "max_attempts" | "is_test_print">): boolean {
  if (job.is_test_print) return false;
  if (job.status === "pending_approval" || job.status === "approved") return true;
  return job.status === "failed" && job.attempt_count < job.max_attempts;
}

async function readOwnJob(service: Client, ref: OwnerRef): Promise<JobFacts | null> {
  const { data } = await service
    .from("print_jobs")
    .select(JOB_COLUMNS)
    .eq("id", ref.jobId)
    .eq("created_by", ref.userId)
    .eq("organization_id", ref.organizationId)
    .maybeSingle();
  return (data as JobFacts | null) ?? null;
}

async function releaseReservation(service: Client, job: JobFacts): Promise<void> {
  try {
    await adjustMonthlyUsage(
      service,
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
      "physical_sheets",
      null,
      "release",
    );
  } catch (err) {
    // The status change already committed; do not fail it back at the user over the refund, but be loud.
    logger.error("failed to release the quota reservation for a cancelled job", {
      jobId: job.id,
      organizationId: job.organization_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function cancelOwnJob(service: Client, ref: OwnerRef): Promise<JobActionResult> {
  const job = await readOwnJob(service, ref);
  if (!job) return { ok: false, error: "Job not found." };

  if (job.status === "cancelled") return { ok: true, message: "This job is already cancelled." };
  if ((WITH_AGENT as readonly string[]).includes(job.status)) return { ok: false, error: GONE_TO_PRINTER };
  if (!(CANCELLABLE as readonly string[]).includes(job.status)) {
    return { ok: false, error: "This job has already finished, so it can no longer be cancelled." };
  }

  // Guarded on the exact status (and attempt count) we decided from: if the agent, an approver or the sweep moved
  // the job in between, zero rows match and nothing below runs.
  let update = service
    .from("print_jobs")
    .update({ status: "cancelled" })
    .eq("id", ref.jobId)
    .eq("created_by", ref.userId)
    .eq("organization_id", ref.organizationId)
    .eq("status", job.status);
  if (job.status === "failed") update = update.eq("attempt_count", job.attempt_count);
  const { data: updated, error } = await update.select("id");
  if (error) {
    logger.error("cancel job failed", { jobId: ref.jobId, error: error.message });
    return { ok: false, error: "Could not cancel this job right now. Try again in a moment." };
  }

  if (!updated || updated.length === 0) {
    // Lost a race. Say what is true now rather than pretending.
    const now = await readOwnJob(service, ref);
    if (!now) return { ok: false, error: "Job not found." };
    if (now.status === "cancelled") return { ok: true, message: "This job is already cancelled." };
    if ((WITH_AGENT as readonly string[]).includes(now.status)) return { ok: false, error: GONE_TO_PRINTER };
    return { ok: false, error: "This job just changed. Refresh the page and try again." };
  }

  await service.from("print_job_events").insert({
    job_id: job.id,
    event_type: "JOB_CANCELLED",
    actor_type: "user",
    actor_id: ref.userId,
    metadata: { previousStatus: job.status },
  });
  if (holdsReservation(job)) await releaseReservation(service, job);

  return { ok: true, message: "Cancelled. Nothing was printed and your quota was released." };
}

type RequeueActor = { type: "user"; id: string } | { type: "system" };

/**
 * failed -> approved, the retry edge. Guarded on the job still being failed with the attempt count we saw, and
 * refused once attempts are used up. Never touches quota (the reservation is kept) and clears the lease so the
 * normal claim loop picks the job up. Returns whether THIS call re-queued it.
 */
export async function requeueFailedJob(
  service: Client,
  job: Pick<JobFacts, "id" | "organization_id" | "attempt_count" | "max_attempts"> & { created_by?: string },
  actor: RequeueActor,
): Promise<boolean> {
  if (job.attempt_count >= job.max_attempts) return false;
  let update = service
    .from("print_jobs")
    .update({ status: "approved", lease_owner_agent_id: null, lease_expires_at: null, error_message: null })
    .eq("id", job.id)
    .eq("organization_id", job.organization_id)
    .eq("status", "failed")
    .eq("attempt_count", job.attempt_count);
  if (actor.type === "user" && job.created_by) update = update.eq("created_by", job.created_by);
  const { data, error } = await update.select("id");
  if (error || !data || data.length === 0) return false;

  await service.from("print_job_events").insert({
    job_id: job.id,
    event_type: "RETRY_SCHEDULED",
    actor_type: actor.type,
    actor_id: actor.type === "user" ? actor.id : null,
    metadata: { attempt: job.attempt_count + 1, of: job.max_attempts, automatic: actor.type === "system" },
  });
  return true;
}

export async function retryOwnJob(service: Client, ref: OwnerRef): Promise<JobActionResult> {
  const job = await readOwnJob(service, ref);
  if (!job) return { ok: false, error: "Job not found." };
  if (job.status === "approved") return { ok: true, message: "This job is already queued to print." };
  if (job.status !== "failed") return { ok: false, error: "Only a job that did not print can be tried again." };
  if (job.attempt_count >= job.max_attempts) {
    return { ok: false, error: "This job has used all of its tries. Use Print again to send a fresh copy." };
  }
  if (job.files_purged_at) {
    return { ok: false, error: "The stored copy of this document was deleted, so it can't be tried again. Upload it again to print." };
  }

  const queued = await requeueFailedJob(service, job, { type: "user", id: ref.userId });
  if (!queued) return { ok: false, error: "This job just changed. Refresh the page and try again." };
  return { ok: true, message: "Queued again. It will print as soon as the print computer picks it up." };
}

/**
 * organization_settings.auto_retry_failed_prints, default OFF. Tolerant of the column not existing yet (migration
 * 0035 not applied): any read problem or missing value means OFF, so deploying the code first is safe.
 */
export async function isAutoRetryEnabled(service: Client, organizationId: string): Promise<boolean> {
  try {
    const { data, error } = await service
      .from("organization_settings")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error || !data) return false;
    return (data as Record<string, unknown>).auto_retry_failed_prints === true;
  } catch {
    return false;
  }
}
