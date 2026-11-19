/**
 * Pure rules for a PDF shared into Printio from another app (Android share sheet -> the web app manifest's
 * share_target -> the service worker). No browser APIs are touched at import time.
 *
 * `checkSharedFile`, `buildShareRedirect` and `handleShare` are written to be SELF-CONTAINED (they reference no
 * module-level names): lib/pwa/sw-source.ts embeds their source text into the service worker, so the code the
 * unit tests exercise is the code the worker runs. Do not make them depend on imports or outer constants.
 */

/**
 * The service worker's own ceiling: deliberately generous, in step with the framework's 100 MB upload ceiling
 * (serverActions.bodySizeLimit in next.config.ts). The worker cannot know the organization's real limit; the Print form
 * checks the shared file against that limit (precheckSelectedFile) and says so in its own words. This one only stops
 * something absurd from being copied into the browser's storage.
 */
export const SHARE_MAX_BYTES = 100 * 1024 * 1024;

export const SHARE_TARGET_PATH = "/share-target";

export type ShareFailure = "notpdf" | "toolarge" | "empty" | "many" | "nofile" | "storage" | "notready";
export type ShareOutcome = { ok: true; id: string } | { ok: false; reason: ShareFailure };

/**
 * Accept a PDF or a photo (JPEG, PNG) by mime type OR file name (Android often labels a Drive/Files document
 * "application/octet-stream" or ""). The real type is then decided by the file's first bytes (`sniffSharedType`).
 * The reason code stays "notpdf" (the Print page's ?share= reader knows it); its notice now says PDFs and photos.
 */
export function checkSharedFile(
  file: { name: string; size: number; type: string },
  maxBytes: number,
): { ok: true } | { ok: false; reason: "notpdf" | "empty" | "toolarge" } {
  const type = String(file.type || "").toLowerCase();
  const byType = type === "application/pdf" || type === "image/jpeg" || type === "image/png";
  const byName = /\.(pdf|jpe?g|png)$/i.test(String(file.name || ""));
  if (!byType && !byName) return { ok: false, reason: "notpdf" };
  if (!(file.size > 0)) return { ok: false, reason: "empty" };
  if (file.size > maxBytes) return { ok: false, reason: "toolarge" };
  return { ok: true };
}

/** The real content type from the first bytes (PDF "%PDF-", JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A), or null. */
export function sniffSharedType(head: Uint8Array): "application/pdf" | "image/jpeg" | "image/png" | null {
  var starts = function (sig: number[]) {
    if (head.length < sig.length) return false;
    for (var i = 0; i < sig.length; i++) if (head[i] !== sig[i]) return false;
    return true;
  };
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
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
  sniff: typeof sniffSharedType;
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
  // The file's own bytes decide the type (a renamed .exe or a mislabelled file is turned away). The stored blob carries
  // the sniffed type, so the Print page can rebuild a correctly typed File from it.
  let kind: ReturnType<typeof sniffSharedType>;
  try {
    kind = deps.sniff(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  } catch {
    return see({ ok: false, reason: "nofile" });
  }
  if (!kind) return see({ ok: false, reason: "notpdf" });
  const id = deps.uuid();
  try {
    await deps.put({ id, name: file.name, size: file.size, blob: file.slice(0, file.size, kind), at: deps.now() });
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
      return `That file is too big to share into Printio (limit ${Math.round(limitBytes / (1024 * 1024))} MB). Choose it on this page instead.`;
    case "notpdf":
      return "Printio can print PDFs and photos (JPEG or PNG). For anything else, open it and choose Print > Save as PDF first.";
    case "notready":
      return "Open Printio once, then share again.";
    case "empty":
      return "That file is empty. Share a different file.";
    case "many":
      return "Printio prints one file at a time. Share just one PDF or photo.";
    case "nofile":
      return "Printio did not receive a file. Try sharing it again.";
    case "storage":
      return "Your browser would not hold the file. Choose it with the button below instead.";
    default:
      return null;
  }
}
