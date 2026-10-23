/**
 * Pure rules for a PDF shared into Printio from another app (Android share sheet -> the web app manifest's
 * share_target -> the service worker). No browser APIs are touched at import time.
 *
 * `checkSharedFile`, `buildShareRedirect` and `handleShare` are written to be SELF-CONTAINED (they reference no
 * module-level names): lib/pwa/sw-source.ts embeds their source text into the service worker, so the code the
 * unit tests exercise is the code the worker runs. Do not make them depend on imports or outer constants.
 */

/** Same figure as the Print form's default (DEFAULT_MAX_UPLOAD_BYTES in lib/pdf/client-precheck.ts). */
export { DEFAULT_MAX_UPLOAD_BYTES as SHARE_MAX_BYTES } from "@/lib/pdf/client-precheck";

export const SHARE_TARGET_PATH = "/share-target";

export type ShareFailure = "notpdf" | "toolarge" | "empty" | "many" | "nofile" | "storage" | "notready";
export type ShareOutcome = { ok: true; id: string } | { ok: false; reason: ShareFailure };

/** Accept by mime type OR a .pdf name (Android often labels a Drive/Files PDF "application/octet-stream" or ""). */
export function checkSharedFile(
  file: { name: string; size: number; type: string },
  maxBytes: number,
): { ok: true } | { ok: false; reason: "notpdf" | "empty" | "toolarge" } {
  const byType = String(file.type || "").toLowerCase() === "application/pdf";
  const byName = /\.pdf$/i.test(String(file.name || ""));
  if (!byType && !byName) return { ok: false, reason: "notpdf" };
  if (!(file.size > 0)) return { ok: false, reason: "empty" };
  if (file.size > maxBytes) return { ok: false, reason: "toolarge" };
  return { ok: true };
}

/** A path only (never an absolute URL), so it works behind any host or proxy. */
export function buildShareRedirect(outcome: ShareOutcome): string {
  if (outcome.ok) return "/print?shared=" + encodeURIComponent(outcome.id);
  return "/print?share=" + outcome.reason;
}

export interface ShareDeps {
  put: (entry: { id: string; name: string; size: number; blob: Blob; at: number }) => Promise<void>;
  now: () => number;
  uuid: () => string;
  check: typeof checkSharedFile;
  redirect: typeof buildShareRedirect;
  maxBytes: number;
}

/** The whole share-target request: read the form, vet ONE file, keep it, answer 303 to the print page. */
export async function handleShare(request: Request, deps: ShareDeps): Promise<Response> {
  const see = (outcome: ShareOutcome) =>
    new Response(null, { status: 303, headers: { Location: deps.redirect(outcome) } });
  let files: File[];
  try {
    const form = await request.formData();
    files = form.getAll("file").filter((v): v is File => typeof v !== "string");
  } catch {
    return see({ ok: false, reason: "nofile" });
  }
  const [file, ...others] = files;
  if (!file) return see({ ok: false, reason: "nofile" });
  if (others.length > 0) return see({ ok: false, reason: "many" });
  const verdict = deps.check(file, deps.maxBytes);
  if (!verdict.ok) return see({ ok: false, reason: verdict.reason });
  const id = deps.uuid();
  try {
    await deps.put({ id, name: file.name, size: file.size, blob: file, at: deps.now() });
  } catch {
    return see({ ok: false, reason: "storage" });
  }
  return see({ ok: true, id });
}

export function isValidShareId(id: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(id);
}

/** Plain-words message for ?share=<code>, or null for a code we do not know. `limitBytes` is the figure the worker enforces. */
export function shareNotice(code: string | null, limitBytes: number): string | null {
  switch (code) {
    case "toolarge":
      return `That file is too big to print from here (limit ${Math.round(limitBytes / (1024 * 1024))} MB).`;
    case "notpdf":
      return "Printio only prints PDFs. Open it and choose Print > Save as PDF first.";
    case "notready":
      return "Open Printio once, then share again.";
    case "empty":
      return "That file is empty. Share a different PDF.";
    case "many":
      return "Printio prints one PDF at a time. Share just one file.";
    case "nofile":
      return "Printio did not receive a file. Try sharing it again.";
    case "storage":
      return "Your browser would not hold the file. Choose it with the button below instead.";
    default:
      return null;
  }
}
