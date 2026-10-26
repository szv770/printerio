"use server";

import { randomUUID } from "node:crypto";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { canUseLinks } from "@/lib/sources/access";
import { normalizeSourceLink } from "@/lib/sources/link";
import { fetchPdf } from "@/lib/sources/fetch-pdf";

export interface ImportLinkResult {
  error?: string;
  /** A short-lived address the browser downloads the fetched PDF from, so it can go into the Print form like a picked file. */
  imported?: { signedUrl: string; fileName: string; bytes: number };
}

const WINDOW_SECONDS = 10 * 60;
const MAX_PER_WINDOW = 20;
const SIGNED_URL_SECONDS = 300;

/**
 * "Print from a link": fetches a public PDF (or Google Drive / Docs file) on the server, with the safety rules in
 * lib/sources/fetch-pdf.ts, and stores it briefly under gateway-intake/ (the weekly cleanup removes anything there older
 * than a day). Nothing is printed here: the browser downloads the file and puts it in the normal Print form, where page
 * choice, preview, booklet and the printing rules all work exactly as for an upload.
 */
export async function importLinkAction(formData: FormData): Promise<ImportLinkResult> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "Your account is not part of an organization yet." };
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) return { error: "Printing from a link is being tested with admins first. Ask an admin to switch early tools on for you." };

  const link = normalizeSourceLink(String(formData.get("link") ?? ""));
  if (!link.ok) return { error: link.message };

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `link_import:user:${session.userId}`,
    p_max_count: MAX_PER_WINDOW,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (!limitError && allowed === false) return { error: "Too many links in a short time. Wait a few minutes and try again." };

  const { data: settings } = await db
    .from("organization_settings")
    .select("max_upload_size_bytes")
    .eq("organization_id", session.membership.organization_id)
    .maybeSingle();
  const maxBytes = settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  const fetched = await fetchPdf(link.url, link.kind, { maxBytes });
  if (!fetched.ok) {
    logger.info("link import refused", { reason: fetched.reason, kind: link.kind, host: link.url.hostname });
    return { error: fetched.message };
  }

  const path = `gateway-intake/link-import-${session.userId}/${randomUUID()}.pdf`;
  const { error: uploadError } = await db.storage.from(PRINT_JOBS_BUCKET).upload(path, fetched.bytes, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    logger.error("link import: could not store the fetched file", { error: uploadError.message });
    return { error: "Printio got the file but could not hold on to it. Try again." };
  }
  const { data: signed, error: signError } = await db.storage.from(PRINT_JOBS_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (signError || !signed) return { error: "Printio got the file but could not hand it over. Try again." };

  return { imported: { signedUrl: signed.signedUrl, fileName: fetched.fileName ?? "From a link.pdf", bytes: fetched.bytes.byteLength } };
}
