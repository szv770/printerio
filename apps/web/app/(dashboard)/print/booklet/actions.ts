"use server";

import { randomUUID } from "node:crypto";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/pdf/client-precheck";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { canUseLinks } from "@/lib/sources/access";
import { assembleBooklet, BuilderError, MAX_SOURCES, type BuilderSource } from "@/lib/booklet/assemble";
import type { Direction } from "@/lib/booklet/bidi";

export interface BuildBookletResult {
  error?: string;
  /** A short-lived address the browser downloads the finished booklet PDF from, to hand it to the Print form. */
  built?: { signedUrl: string; fileName: string; pageCount: number };
}

const WINDOW_SECONDS = 10 * 60;
const MAX_PER_WINDOW = 10;
const SIGNED_URL_SECONDS = 300;
/** All the files of one booklet together (the Server Action body limit is 100 MB). */
const MAX_TOTAL_BYTES = 90 * 1024 * 1024;

const text = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

function safeFileName(title: string): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return `${cleaned || "Booklet"}.pdf`;
}

/**
 * Builds ONE PDF from several: optional cover and contents pages, then the chosen pages of each file in order
 * (lib/booklet/assemble.ts). Nothing is printed here. The finished PDF is held briefly under gateway-intake/ (swept by the
 * weekly cleanup) and the browser downloads it and hands it to the normal Print form, where the preview, the blank pages
 * note, the printer, finishing and the printing rules all work as for any upload. Admins, and people an admin switched early tools on for.
 *
 * Form fields: title, description, direction ("ltr" | "rtl"), cover/contents ("on"), count, then for each file i:
 * file-i (the PDF), title-i, pages-i (typed range, blank = all), credit-i.
 */
export async function buildBookletAction(formData: FormData): Promise<BuildBookletResult> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "Your account is not part of an organization yet." };
  if (!canUseLinks(session.membership.role, session.membership.early_tools)) return { error: "Building booklets is being tested with admins first. Ask an admin to switch early tools on for you." };

  const count = Number(text(formData, "count"));
  if (!Number.isInteger(count) || count < 1) return { error: "Add at least one file to the booklet." };
  if (count > MAX_SOURCES) return { error: `A booklet can combine up to ${MAX_SOURCES} files.` };

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `booklet_build:user:${session.userId}`,
    p_max_count: MAX_PER_WINDOW,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (!limitError && allowed === false) return { error: "Too many booklets in a short time. Wait a few minutes and try again." };

  const { data: settings } = await db
    .from("organization_settings")
    .select("max_upload_size_bytes")
    .eq("organization_id", session.membership.organization_id)
    .maybeSingle();
  const maxFileBytes = settings?.max_upload_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  const sources: BuilderSource[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const file = formData.get(`file-${i}`);
    const label = text(formData, `title-${i}`).trim() || `File ${i + 1}`;
    if (!(file instanceof File) || file.size === 0) return { error: `"${label}" is missing its file. Add it again.` };
    if (file.size > maxFileBytes) return { error: `"${label}" is larger than the ${Math.round(maxFileBytes / (1024 * 1024))} MB limit.` };
    total += file.size;
    if (total > MAX_TOTAL_BYTES) return { error: "These files are too large to combine in one go. Use fewer pages or fewer files." };
    sources.push({
      title: label,
      bytes: new Uint8Array(await file.arrayBuffer()),
      pageRange: text(formData, `pages-${i}`),
      credit: text(formData, `credit-${i}`),
    });
  }

  const title = text(formData, "title");
  let result;
  try {
    result = await assembleBooklet({
      title,
      description: text(formData, "description"),
      direction: (text(formData, "direction") === "rtl" ? "rtl" : "ltr") satisfies Direction,
      sources,
      cover: text(formData, "cover") === "on",
      contents: text(formData, "contents") === "on",
      sponsorLine: text(formData, "sponsor"),
      backPage: text(formData, "backPage") === "on",
    });
  } catch (err) {
    if (err instanceof BuilderError) return { error: err.message };
    logger.error("booklet build failed", { error: err instanceof Error ? err.message : String(err) });
    return { error: "Printio could not combine these files. Try re-exporting them as PDFs and add them again." };
  }

  const path = `gateway-intake/booklet-${session.userId}/${randomUUID()}.pdf`;
  const { error: uploadError } = await db.storage.from(PRINT_JOBS_BUCKET).upload(path, result.bytes, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    logger.error("booklet build: could not store the result", { error: uploadError.message });
    return { error: "Printio built the booklet but could not hold on to it. Try again." };
  }
  const { data: signed, error: signError } = await db.storage.from(PRINT_JOBS_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (signError || !signed) return { error: "Printio built the booklet but could not hand it over. Try again." };

  return { built: { signedUrl: signed.signedUrl, fileName: safeFileName(title), pageCount: result.pageCount } };
}
