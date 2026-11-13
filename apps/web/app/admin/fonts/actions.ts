"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireOrgRole } from "@/lib/auth/session";
import { FONT_BUCKET, MAX_FONTS_PER_ORG, MAX_FONT_BYTES, inspectFont } from "@/lib/booklet/custom-font";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

export interface FontActionResult {
  ok: boolean;
  message: string;
}

const fail = (message: string): FontActionResult => ({ ok: false, message });

/** Upload a Hebrew font (.ttf/.otf). Org admins only; the bytes go to the private org-fonts bucket via the service role. */
export async function uploadFontAction(formData: FormData): Promise<FontActionResult> {
  const session = await requireOrgRole(["org_admin"]);
  const organizationId = session.membership.organization_id;

  const file = formData.get("file");
  if (typeof file === "string" || file === null) return fail("Choose a font file (.ttf or .otf).");
  if (file.size === 0) return fail("That file is empty.");
  if (file.size > MAX_FONT_BYTES) return fail("That font file is bigger than 8 MB. Choose a smaller file.");

  const db = createServiceRoleClient();
  const { data: allowed, error: limitError } = await db.rpc("check_rate_limit", {
    p_key: `font_upload:user:${session.userId}`,
    p_max_count: 10,
    p_window_seconds: 10 * 60,
  });
  if (!limitError && allowed === false) return fail("That is a lot of uploading at once. Wait a few minutes and try again.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspected = inspectFont(bytes, file.name);
  if (!inspected.ok) return fail(inspected.message);

  const { data: existing, error: listError } = await db
    .from("org_fonts")
    .select("id, name")
    .eq("organization_id", organizationId)
    .limit(MAX_FONTS_PER_ORG + 1);
  if (listError) {
    logger.error("could not list fonts before an upload", { organizationId, error: listError.message });
    return fail("Couldn't save the font. Try again in a moment.");
  }
  const fonts = existing ?? [];
  if (fonts.some((f) => f.name.toLowerCase() === inspected.name.toLowerCase())) {
    return fail(`A font named "${inspected.name}" is already uploaded. Delete it first if you want to replace it.`);
  }
  if (fonts.length >= MAX_FONTS_PER_ORG) {
    return fail(`You can keep up to ${MAX_FONTS_PER_ORG} fonts. Delete one you no longer use, then try again.`);
  }

  const fontId = crypto.randomUUID();
  const storagePath = `org/${organizationId}/${fontId}.font`;
  const { error: uploadError } = await db.storage
    .from(FONT_BUCKET)
    .upload(storagePath, bytes, { contentType: "application/octet-stream", upsert: false });
  if (uploadError) {
    logger.error("font upload to storage failed", { organizationId, error: uploadError.message });
    return fail("Couldn't save the font. Try again in a moment.");
  }

  const { error: insertError } = await db.from("org_fonts").insert({
    id: fontId,
    organization_id: organizationId,
    name: inspected.name,
    file_name: file.name.slice(0, 200),
    storage_path: storagePath,
    size_bytes: bytes.length,
    has_vowels: inspected.hasVowels,
    has_cantillation: inspected.hasCantillation,
    created_by: session.userId,
  });
  if (insertError) {
    // Don't leave an orphaned file behind.
    const { error: cleanupError } = await db.storage.from(FONT_BUCKET).remove([storagePath]);
    if (cleanupError) logger.error("could not remove a font file after a failed save", { organizationId, error: cleanupError.message });
    if ((insertError as { code?: string }).code === "23505") {
      return fail(`A font named "${inspected.name}" is already uploaded. Delete it first if you want to replace it.`);
    }
    logger.error("font row insert failed", { organizationId, error: insertError.message });
    return fail("Couldn't save the font. Try again in a moment.");
  }

  await auditFont("font.uploaded", session.userId, organizationId, fontId, { name: inspected.name, sizeBytes: bytes.length });
  revalidatePath(routes.adminFonts);
  return { ok: true, message: `Added "${inspected.name}".` };
}

/** Delete one of this organization's fonts (the stored file and its row). Org admins only. */
export async function deleteFontAction(fontId: string): Promise<FontActionResult> {
  const session = await requireOrgRole(["org_admin"]);
  const organizationId = session.membership.organization_id;
  if (typeof fontId !== "string" || fontId.length === 0 || fontId.length > 64) return fail("That font could not be found.");

  const db = createServiceRoleClient();
  const { data: row, error: readError } = await db
    .from("org_fonts")
    .select("id, name, storage_path")
    .eq("id", fontId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (readError) {
    logger.error("could not read a font before deleting it", { organizationId, error: readError.message });
    return fail("Couldn't remove the font. Try again in a moment.");
  }
  if (!row) return fail("That font could not be found. It may already be removed.");

  if (row.storage_path) {
    const { error: removeError } = await db.storage.from(FONT_BUCKET).remove([row.storage_path]);
    if (removeError) {
      // Keep the row so the admin can retry; deleting it would orphan the file for good.
      logger.error("could not remove a font file", { organizationId, error: removeError.message });
      return fail("Couldn't remove the font. Try again in a moment.");
    }
  }
  const { error: deleteError } = await db.from("org_fonts").delete().eq("id", fontId).eq("organization_id", organizationId);
  if (deleteError) {
    logger.error("could not delete a font row", { organizationId, error: deleteError.message });
    return fail("Couldn't remove the font. Try again in a moment.");
  }

  await auditFont("font.deleted", session.userId, organizationId, fontId, { name: row.name });
  revalidatePath(routes.adminFonts);
  return { ok: true, message: `Removed "${row.name}".` };
}

async function auditFont(
  action: "font.uploaded" | "font.deleted",
  actorId: string,
  organizationId: string,
  fontId: string,
  metadata: Record<string, string | number>,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: actorId,
    action,
    target_type: "org_font",
    target_id: fontId,
    metadata,
  });
  if (error) logger.error("failed to audit-log a font change", { organizationId, action, error: error.message });
}
