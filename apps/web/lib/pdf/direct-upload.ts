/**
 * Browser side of a direct upload (server side: lib/jobs/staged-upload.ts). A large PDF cannot go inside a Server
 * Action (Vercel rejects request bodies over about 4.5 MB), so: ask the server for a signed upload slot, upload the
 * file straight to Supabase Storage with it, then submit only the staged path. The two failure kinds get different
 * words: the upload itself failing (connection) versus the server saying no (size limit, rate limit, ...).
 */

/** Files at or below this still go inside the form post (one round trip, below the platform body limit). */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 3_500_000;

export const UPLOAD_NETWORK_FAILED =
  "Your file didn't reach Printio: the connection dropped while uploading it. Nothing was printed. Check your connection and press the button again.";

export type StageResult = { ok: true; path: string } | { ok: false; error: string };

export interface StageDeps {
  getSlot(claimedBytes: number): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }>;
  upload(path: string, token: string, file: File): Promise<{ error: { message: string } | null }>;
}

export async function stageLargeFile(file: File, deps: StageDeps): Promise<StageResult> {
  let slot;
  try {
    slot = await deps.getSlot(file.size);
  } catch {
    return { ok: false, error: UPLOAD_NETWORK_FAILED };
  }
  if (!slot.ok) return { ok: false, error: slot.error };
  try {
    const { error } = await deps.upload(slot.path, slot.token, file);
    if (error) return { ok: false, error: `Storage refused the upload (${error.message}). Try again, or use a smaller file.` };
  } catch {
    return { ok: false, error: UPLOAD_NETWORK_FAILED };
  }
  return { ok: true, path: slot.path };
}

/** The browser half of the real dependencies: the upload itself, with the browser Supabase client and the signed token. */
export async function browserUpload(path: string, token: string, file: File): Promise<{ error: { message: string } | null }> {
  const [{ createClient }, { PRINT_JOBS_BUCKET }] = await Promise.all([import("@/lib/supabase/client"), import("@/lib/storage")]);
  const { error } = await createClient().storage.from(PRINT_JOBS_BUCKET).uploadToSignedUrl(path, token, file, { contentType: "application/pdf" });
  return { error: error ? { message: error.message } : null };
}
