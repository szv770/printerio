import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { loadStagedPdf } from "@/lib/jobs/staged-upload";
import { logger } from "@/lib/logger";

export type FormPdf = { ok: true; bytes: Uint8Array; fileName: string } | { ok: false; error: string };

/**
 * The PDF of a print/preview submission, from either of the two ways the browser can send it: inline as the
 * "file" part (small files), or as "stagedPath" + "fileName" (large files uploaded straight to Storage first, see
 * lib/jobs/staged-upload.ts). The staged route re-checks the real object size against the organization's limit.
 */
export async function readFormPdf(formData: FormData, session: { userId: string; membership: { organization_id: string } }): Promise<FormPdf> {
  const stagedPath = formData.get("stagedPath");
  if (typeof stagedPath === "string" && stagedPath !== "") {
    const db = createServiceRoleClient();
    const { data: settings } = await db
      .from("organization_settings")
      .select("max_upload_size_bytes")
      .eq("organization_id", session.membership.organization_id)
      .maybeSingle();
    const loaded = await loadStagedPdf(db, session.userId, stagedPath, settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES);
    if (!loaded.ok) return loaded;
    const name = formData.get("fileName");
    return { ok: true, bytes: loaded.bytes, fileName: typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 200) : "upload.pdf" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a PDF to upload." };
  // A File handed to a Server Action can still fail to read - a multipart body cut short mid-upload (a phone dropping
  // off wifi is the everyday case). Uncaught, that threw out of the action and rendered the error boundary.
  try {
    return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name };
  } catch (err) {
    logger.error("could not read the uploaded file", { userId: session.userId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Your file didn't finish uploading. Check your connection and submit again." };
  }
}
