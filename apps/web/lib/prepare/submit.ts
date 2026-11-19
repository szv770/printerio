import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { JobOptions, JobSession } from "@/lib/jobs/create-print-job";
import { isOwnStagedPath, stagedPathFor } from "@/lib/jobs/staged-upload";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { intakePrintJob, type IntakeResult } from "./intake";

/** Is this school switched on for preparing PDFs on its print server? (organization_settings.prepare_via_server, off by default.) A read failure means off. */
export async function prepareViaServerEnabled(db: SupabaseClient<Database>, organizationId: string): Promise<boolean> {
  const { data } = await db.from("organization_settings").select("prepare_via_server").eq("organization_id", organizationId).maybeSingle();
  return data?.prepare_via_server === true;
}

export interface SubmitFile {
  /** A file the browser already uploaded straight to storage (large files). */
  stagedPath?: string | null;
  /** Or the file's bytes (small files travel inside the form); they are put in storage here so the print server can fetch them. */
  bytes?: Uint8Array | null;
  fileName: string;
}

/**
 * The submit for a school on the print-server path: make sure the original is in storage, then record the prepare job (no PDF work happens here).
 * `db` is the service-role client (already authenticated by the caller); `supabase` is the member's own client for reads under RLS.
 */
export async function submitViaPrintServer(
  supabase: SupabaseClient<Database>,
  db: SupabaseClient<Database>,
  session: JobSession,
  file: SubmitFile,
  opts: JobOptions,
): Promise<IntakeResult> {
  let path: string;
  if (file.stagedPath) {
    if (!isOwnStagedPath(session.userId, file.stagedPath)) return { ok: false, kind: "error", error: "Your file didn't finish uploading. Check your connection and submit again.", code: "storage_failed" };
    path = file.stagedPath;
  } else if (file.bytes && file.bytes.byteLength > 0) {
    path = stagedPathFor(session.userId);
    const { error } = await db.storage.from(PRINT_JOBS_BUCKET).upload(path, file.bytes, { contentType: "application/pdf", upsert: false });
    if (error) {
      logger.error("could not store an upload for the print server", { userId: session.userId, error: error.message });
      return { ok: false, kind: "error", error: "Your file could not be stored. Try again.", code: "storage_failed" };
    }
  } else {
    return { ok: false, kind: "error", error: "Choose a PDF to upload.", code: "invalid_request" };
  }
  return intakePrintJob(supabase, session, path, file.fileName, { ...opts, writeClient: db });
}
