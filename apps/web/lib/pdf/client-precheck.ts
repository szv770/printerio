/**
 * Advisory, in-browser checks on a file the user just picked, run BEFORE the
 * bytes are shipped to the server action.
 *
 * This is purely a courtesy to the user and is never a security or policy
 * boundary: lib/pdf/preflight.ts re-runs the size check, the %PDF- magic-byte
 * check and the full structural parse server-side on the real bytes, and
 * remains the only source of truth for anything quota- or policy-relevant.
 * Nothing here is trusted by the server, and skipping it (scripted POST,
 * disabled JS) changes nothing about what actually gets accepted.
 *
 * The reason it exists: without it, picking a 90 MB scan or a renamed .docx
 * means uploading the whole thing over a school connection - potentially
 * minutes - only to be told it was never going to be accepted. The rejection
 * is knowable the instant the file is chosen, so it should be shown then.
 */

/** Mirrors organization_settings.max_upload_size_bytes' own default (50 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 52428800;

export type ClientPrecheckResult = { ok: true } | { ok: false; reason: string };

/** Human-readable file size for UI copy - "4.2 MB", "812 KB", "0.5 KB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(0.1, bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/**
 * Cheap checks that need only the File's own metadata - runs synchronously
 * the moment a file is selected, before any parse or read.
 */
export function precheckSelectedFile(
  file: { name: string; size: number; type: string },
  maxUploadBytes: number,
): ClientPrecheckResult {
  if (file.size === 0) {
    return { ok: false, reason: "That file is empty. Choose a different PDF." };
  }
  if (file.size > maxUploadBytes) {
    const maxMb = (maxUploadBytes / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      reason: `That file is ${formatFileSize(file.size)} - the limit here is ${maxMb} MB. Choose a smaller PDF, or ask your administrator to raise the limit.`,
    };
  }
  // The `accept` attribute only filters the picker's default view - a user can
  // still choose "All files", drag one in, or come from a Files app that
  // reports no MIME type at all, so an empty `type` is not treated as wrong.
  const looksPdf = file.type === "application/pdf" || file.type === "" || /\.pdf$/i.test(file.name);
  if (!looksPdf) {
    return { ok: false, reason: "Only PDF files can be printed. Save or export your document as a PDF first." };
  }
  return { ok: true };
}

/**
 * Confirms the leading bytes really are a PDF, whatever the file was named or
 * what MIME type the browser claimed. Mirrors preflight.ts's magic-byte check
 * so a renamed .docx is caught here rather than after a full upload.
 */
export function precheckPdfHeader(headerBytes: Uint8Array): ClientPrecheckResult {
  const header = new TextDecoder("utf-8", { fatal: false }).decode(headerBytes.slice(0, 5));
  if (header !== "%PDF-") {
    return { ok: false, reason: "That file isn't a PDF, even though it's named like one. Export it as a PDF and try again." };
  }
  return { ok: true };
}
