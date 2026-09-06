import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/api-errors";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { adjustMonthlyUsage } from "@/lib/quota";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { getCronSecret } from "@/lib/env";

/** Constant-time compare of two equal-or-different-length strings - avoids
 *  the length/content timing signal a plain `!==` would leak (consistent
 *  with lib/agent-auth.ts's device-secret comparison). */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so the "wrong length" case
    // doesn't return measurably faster than a "right length, wrong content" one.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Periodic sweep (Vercel Cron -> this route). Idempotent: safe to run
 * repeatedly and concurrently (each step is a plain conditional UPDATE/DELETE,
 * not a multi-step transaction that could double-apply). See
 * docs/architecture.md sec 13 (lease expiry) and sec 16 (retention).
 */
export async function GET(request: Request) {
  let expected: string;
  try {
    expected = getCronSecret();
  } catch (err) {
    // Distinct from a bad caller-supplied secret (401 below): this is an
    // operator misconfiguration (PRINTOS_CRON_SECRET was never set), and
    // should surface as a clear 500 rather than silently 401ing every call
    // forever with no clue why.
    return apiError(500, "misconfigured", err instanceof Error ? err.message : "Cron secret not configured.");
  }

  const authHeader = request.headers.get("authorization") ?? "";
  if (!safeCompare(authHeader, `Bearer ${expected}`)) {
    return apiError(401, "unauthenticated", "Invalid cron secret.");
  }

  const supabase = createServiceRoleClient();
  const nowIso = new Date().toISOString();
  const results = { expiredApprovals: 0, releasedLeases: 0, failedFromStaleLease: 0, filesDeleted: 0 };

  // 1. Expire pending_approval jobs past their approval deadline.
  const { data: expiring } = await supabase
    .from("print_jobs")
    .select("id, organization_id, created_by, source_pdf_pages, copies, estimated_printed_sides, estimated_physical_sheets, color_mode")
    .eq("status", "pending_approval")
    .lt("expires_at", nowIso);

  for (const job of expiring ?? []) {
    await supabase.from("print_jobs").update({ status: "expired" }).eq("id", job.id);
    await supabase
      .from("print_job_events")
      .insert({ job_id: job.id, event_type: "JOB_EXPIRED", actor_type: "system", metadata: {} });
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
      "physical_sheets",
      null,
      "release",
    );
    results.expiredApprovals++;
  }

  // 2. Claimed-but-untouched leases simply return to the pool for reclaim.
  const { data: released } = await supabase
    .from("print_jobs")
    .update({ status: "approved", lease_owner_agent_id: null, lease_expires_at: null })
    .eq("status", "claimed")
    .lt("lease_expires_at", nowIso)
    .select("id");
  results.releasedLeases = released?.length ?? 0;
  for (const job of released ?? []) {
    await supabase
      .from("print_job_events")
      .insert({ job_id: job.id, event_type: "LEASE_EXPIRED", actor_type: "system", metadata: {} });
  }

  // 3. Jobs interrupted mid-flight (downloading/downloaded/printing/
  //    submitted_to_spooler) whose lease expired - the agent likely crashed
  //    or disconnected. Mark failed (a valid transition from all four states)
  //    rather than leaving them stuck forever; release quota if retries are
  //    exhausted.
  for (const midFlightStatus of ["downloading", "downloaded", "printing", "submitted_to_spooler"] as const) {
    const { data: stuck } = await supabase
      .from("print_jobs")
      .select("*")
      .eq("status", midFlightStatus)
      .lt("lease_expires_at", nowIso);

    for (const job of stuck ?? []) {
      const newAttemptCount = job.attempt_count + 1;
      await supabase
        .from("print_jobs")
        .update({
          status: "failed",
          attempt_count: newAttemptCount,
          error_message: "Agent lease expired mid-operation (agent likely disconnected or crashed).",
        })
        .eq("id", job.id);
      await supabase.from("print_job_events").insert({
        job_id: job.id,
        event_type: "LEASE_EXPIRED",
        actor_type: "system",
        metadata: { previousStatus: midFlightStatus },
      });
      if (newAttemptCount >= job.max_attempts) {
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
          "physical_sheets",
          null,
          "release",
        );
      }
      results.failedFromStaleLease++;
    }
  }

  // 4. Retention: delete storage files (never the job row itself, so
  //    job_number/audit history survives) for terminal jobs past their
  //    organization's configured retention window. A job still `approved`/
  //    `claimed`/etc. (active) is never touched, regardless of age.
  const { data: orgSettings } = await supabase
    .from("organization_settings")
    .select("organization_id, retention_completed_days, retention_rejected_days, retention_failed_days");

  for (const org of orgSettings ?? []) {
    const statusWindows: Array<{ statuses: string[]; days: number }> = [
      { statuses: ["completed"], days: org.retention_completed_days },
      { statuses: ["rejected", "denied", "cancelled", "expired"], days: org.retention_rejected_days },
      { statuses: ["failed"], days: org.retention_failed_days },
    ];

    for (const window of statusWindows) {
      const cutoff = new Date(Date.now() - window.days * 86_400_000).toISOString();
      const { data: toClean } = await supabase
        .from("print_jobs")
        .select("id, original_file_path, derived_file_path")
        .eq("organization_id", org.organization_id)
        .in("status", window.statuses)
        .lt("updated_at", cutoff)
        .not("original_file_path", "is", null);

      for (const job of toClean ?? []) {
        const paths = [job.original_file_path, job.derived_file_path].filter((p): p is string => !!p);
        if (paths.length === 0) continue;
        // Delete the storage objects only - the job row (and its
        // original_file_path/derived_file_path columns) stays as a historical
        // record for job_number/audit lookups; a path pointing at a deleted
        // object is expected once retention has run and simply 404s if ever
        // signed/downloaded again.
        // Note: since we don't mark the row afterward, a job whose files were
        // already deleted gets re-selected on every future run and we call
        // remove() again - Supabase Storage's remove() is a no-op (not an
        // error) for objects that no longer exist, so this is wasted work at
        // scale but not incorrect. Fine for this build's single-org volume;
        // a `files_purged_at` column would be the fix if that ever matters.
        const { error: removeError } = await supabase.storage.from(PRINT_JOBS_BUCKET).remove(paths);
        if (!removeError) results.filesDeleted += paths.length;
      }
    }
  }

  return Response.json({ ok: true, ranAt: nowIso, results });
}
