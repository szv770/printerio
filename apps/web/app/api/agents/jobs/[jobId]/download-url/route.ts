import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import type { ResolvedPrintRequest } from "@printos/shared";

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
  const printRequest: ResolvedPrintRequest = {
    jobId: job.id,
    printerProfileId: profile.id,
    windowsQueueName: profile.windows_queue_name,
    pageCount: job.derived_file_path ? job.source_pdf_pages + job.booklet_padding_added : job.source_pdf_pages,
    copies: job.copies,
    colorMode: job.color_mode as "bw" | "color",
    duplex: job.duplex,
    paperSize: job.paper_size,
    finishing,
  };

  return Response.json({
    downloadUrl: signed.signedUrl,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    fileName: job.original_file_name,
    printRequest,
  });
}
