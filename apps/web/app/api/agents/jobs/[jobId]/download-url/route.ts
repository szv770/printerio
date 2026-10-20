import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { rawTargetFromProfile } from "@/lib/printers/raw-target";
import type { ResolvedPrintRequest } from "@printio/shared";

const SIGNED_URL_TTL_SECONDS = 300;

/**
 * See docs/agent-api.md. Requires an active lease held by this agent.
 * Resolves the logical print request - `windowsQueueName` is only ever
 * revealed to the authenticated Agent that owns the printer_profile, never to
 * a browser client (docs/architecture.md sec 9).
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  const { jobId } = await params;

  const supabase = createServiceRoleClient();
  const { data: job } = await supabase.from("print_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job || job.organization_id !== agent.organizationId) return apiError(404, "not_found", "Job not found.");
  if (job.lease_owner_agent_id !== agent.id || !job.lease_expires_at || new Date(job.lease_expires_at) < new Date()) {
    return apiError(403, "no_lease", "You do not hold an active lease on this job.");
  }
  if (job.status !== "claimed") {
    return apiError(409, "wrong_state", `Job is in state '${job.status}', expected 'claimed'.`);
  }
  if (!job.printer_profile_id) return apiError(409, "no_profile", "Job has no printer profile assigned.");

  const { data: profile } = await supabase
    .from("printer_profiles")
    .select("*")
    .eq("id", job.printer_profile_id)
    .maybeSingle();
  if (!profile) return apiError(500, "internal_error", "Printer profile missing.");

  const path = job.derived_file_path ?? job.original_file_path;
  const { data: signed, error: signError } = await supabase.storage
    .from(PRINT_JOBS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed) return apiError(500, "internal_error", "Failed to create a download URL.");

  await supabase.from("print_jobs").update({ status: "downloading" }).eq("id", jobId);
  await supabase.from("print_job_events").insert({
    job_id: jobId,
    event_type: "DOWNLOAD_STARTED",
    actor_type: "agent",
    actor_id: agent.id,
    metadata: {},
  });

  const finishing = job.finishing as { staple: boolean; booklet: boolean; punch: boolean };

  // For a booklet job, `derived_file_path` is the fully-IMPOSED PDF
  // (apps/web/lib/pdf/imposition.ts) - N/2 landscape sheet-sides, not the N
  // padded portrait pages that went into imposition. For a non-booklet job,
  // `derived_file_path` (when present) is still just the padded page count.
  const paddedPageCount = job.source_pdf_pages + job.booklet_padding_added;
  const pageCount = job.derived_file_path
    ? finishing.booklet
      ? paddedPageCount / 2
      : paddedPageCount
    : job.source_pdf_pages;

  // Raw (direct-to-printer) profiles carry no Windows queue; the Agent sends
  // the job straight to host:port instead.
  const raw = rawTargetFromProfile(profile, { jobTitle: job.original_file_name });

  const printRequest: ResolvedPrintRequest = {
    jobId: job.id,
    printerProfileId: profile.id,
    windowsQueueName: raw ? "" : (profile.windows_queue_name ?? ""),
    ...(raw ? { raw } : {}),
    pageCount,
    copies: job.copies,
    colorMode: job.color_mode as "bw" | "color",
    duplex: job.duplex,
    paperSize: job.paper_size,
    finishing,
    // Printio has already imposed and independently scaled a booklet job's
    // pages to the exact target sheet size - request the driver print it at
    // 100%, never fit/shrink (which would re-scale an already-correct page
    // and undo the whole point of doing our own imposition). Every other
    // job type is left unset, so the Agent falls back to its own
    // PRINTIO_PRINT_FIT_MODE default (apps/agent/src/config.ts) exactly as
    // before - see apps/agent/src/orchestrator.ts.
    ...(finishing.booklet ? { fitMode: "noscale" as const } : {}),
  };

  return Response.json({
    downloadUrl: signed.signedUrl,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    fileName: job.original_file_name,
    printRequest,
  });
}
