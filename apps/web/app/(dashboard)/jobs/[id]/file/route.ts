import { getCurrentSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { canViewJobFile, jobFilePath, parseFileWhich } from "@/lib/jobs/file-access";
import { logger } from "@/lib/logger";

/** A short-lived link, minted fresh on every click; the browser follows it at once. */
const FILE_URL_TTL_SECONDS = 120;

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * GET /jobs/<id>/file?which=original|sent - opens the job's stored PDF in the browser.
 * Allowed for the person who sent the job and for the admins/approvers of the same organization (lib/jobs/file-access.ts).
 * The row is read with the viewer's own session (row-level security already hides other people's jobs), the rule is
 * checked again here, and only then is a signed link minted with the service role (members have no direct storage access).
 * The path comes from the verified row, never from the request. Answers "not found" for anything the viewer may not see.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return plain(401, "Sign in first.");
  const { id } = await params;
  const which = parseFileWhich(new URL(request.url).searchParams.get("which"));

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("print_jobs")
    .select("id, organization_id, created_by, original_file_path, derived_file_path, files_purged_at")
    .eq("id", id)
    .maybeSingle();
  const viewer = { userId: session.userId, role: session.membership?.role ?? null, organizationId: session.membership?.organization_id ?? null };
  if (!job || !canViewJobFile(viewer, job)) return plain(404, "Job not found.");

  const path = jobFilePath(job, which);
  if (!path) return plain(410, "This job's file has been deleted.");

  const { data: signed, error } = await createServiceRoleClient().storage.from(PRINT_JOBS_BUCKET).createSignedUrl(path, FILE_URL_TTL_SECONDS);
  if (error || !signed) {
    logger.error("failed to sign a job file link", { jobId: id, which, error: error?.message });
    return plain(502, "Could not open this file right now. Try again in a moment.");
  }
  return new Response(null, { status: 302, headers: { location: signed.signedUrl, "cache-control": "no-store" } });
}
