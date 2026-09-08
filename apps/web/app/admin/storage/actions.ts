"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { sweepRetention } from "@/lib/retention";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

export interface StorageCleanupState {
  error?: string;
  success?: string;
}

/** Same per-pass cap the scheduled sweep uses (app/api/cron/sweep/route.ts).
 *  A pass that hits it makes partial progress and says so, rather than
 *  running unbounded inside a Server Action. */
const CLEANUP_LIMIT = 500;

/**
 * "Clean up now" - runs the scheduled retention sweep's own pass
 * (lib/retention.ts) immediately, for this admin's organization only, instead
 * of waiting for the next cron tick.
 *
 * Deliberately the *same* pass, not a more aggressive one: it removes exactly
 * the files the automatic sweep would already remove (terminal jobs past this
 * organization's configured retention windows), never a file belonging to a
 * job that is still in flight or still inside its window. And, like the
 * sweep, it only ever removes Storage objects - the print_jobs rows, their
 * job numbers and their event history all survive.
 *
 * Runs as the calling admin (not service-role): Storage's delete policy
 * already admits an org_admin for their own org's path prefix
 * (0007_storage.sql) and print_jobs' update policy admits them via
 * private.is_org_approver, so RLS remains the enforcement point end to end -
 * an admin cannot reach another organization's files even if this action had
 * a bug in its own scoping.
 */
export async function runStorageCleanupAction(
  _prev: StorageCleanupState,
  _formData: FormData,
): Promise<StorageCleanupState> {
  const session = await requireOrgRole(["org_admin"]);
  const organizationId = session.membership.organization_id;
  const supabase = await createClient();

  let result;
  try {
    result = await sweepRetention(supabase, { now: new Date(), limit: CLEANUP_LIMIT, organizationId });
  } catch (err) {
    logger.error("manual storage cleanup failed", {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: "Couldn't finish the cleanup. Nothing was left half-done - try again in a moment." };
  }

  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: session.userId,
    action: "storage.cleanup_run",
    target_type: "organization",
    target_id: organizationId,
    metadata: { filesDeleted: result.filesDeleted, jobsPurged: result.jobsPurged },
  });
  if (auditError) {
    // The files are already gone - don't fail the action back to the admin
    // over the log line, but make the gap visible server-side.
    logger.error("failed to audit-log a manual storage cleanup", {
      organizationId,
      error: auditError.message,
    });
  }

  revalidatePath(routes.adminStorage);

  if (result.jobsPurged === 0) {
    return { success: "Nothing to clean up - no finished job is past its retention window yet." };
  }
  return {
    success:
      `Removed ${result.filesDeleted} ${result.filesDeleted === 1 ? "file" : "files"} from ` +
      `${result.jobsPurged} ${result.jobsPurged === 1 ? "job" : "jobs"}. ` +
      "The jobs themselves (and their history) are still here - only the stored PDFs were deleted.",
  };
}
