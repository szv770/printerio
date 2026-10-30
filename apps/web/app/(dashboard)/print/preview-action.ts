"use server";

import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { parseChoices, mapRawChoices, mapQueueChoices, type BindingSide } from "@/lib/print-choices";
import { buildBookletPreviewPdf } from "@/lib/jobs/booklet-preview";
import { bookletSheetChoice } from "@/lib/pdf/booklet-build";
import { buildStampText, normalizeStampSettings } from "@/lib/jobs/user-code";
import { logger } from "@/lib/logger";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { readFormPdf } from "./form-pdf";

const SIGNED_URL_SECONDS = 300;

export type BookletPreviewState =
  | {
      ok: true;
      /**
       * Short-lived signed address of the imposed booklet PDF (what would be sent to the printer). The PDF is held
       * briefly under gateway-intake/ (the cleanup sweeps it) and NOT in the response: serverless responses are
       * limited to about 4.5 MB, which a base64 preview could exceed. No job or quota is involved.
       */
      pdfUrl: string;
      bindingSide: BindingSide;
      sourcePages: number;
      paddedPages: number;
      blankPagesAdded: number;
      sheets: number;
    }
  | { ok: false; error: string; fieldErrors?: { pageRange?: string } };

/**
 * "Preview booklet": runs the booklet part of the print pipeline on the picked file (page range, blank-page
 * padding, imposition with the chosen fit and binding side, the page-1 stamp) and returns the imposed PDF without
 * creating a job, reserving quota or storing anything. Same session check and per-user rate limit style as
 * submitting; the file is size-limited by the organization's upload limit (and a smaller preview ceiling). Large files arrive as a staged path (see form-pdf.ts)..
 */
export async function previewBookletAction(formData: FormData): Promise<BookletPreviewState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, error: "You are not a member of any organization yet." };
  const organizationId = session.membership.organization_id;

  const parsed = parseChoices((name) => formData.get(name));
  if (!parsed.ok) return { ok: false, error: parsed.reason };
  const choices = parsed.choices;
  if (choices.booklet === "none") return { ok: false, error: "Choose a booklet (left or right edge) to preview it." };

  const supabase = await createClient();

  // Through the service-role client: members no longer have EXECUTE on check_rate_limit (migration 0037). The session
  // and membership checks above authorize this call; the key is the caller's own id, as before.
  const { data: withinLimit, error: rateLimitError } = await createServiceRoleClient().rpc("check_rate_limit", {
    p_key: `booklet_preview:${session.userId}`,
    p_max_count: 30,
    p_window_seconds: 300,
  });
  if (rateLimitError) {
    logger.error("rate limit check failed", { userId: session.userId, error: rateLimitError.message });
  } else if (!withinLimit) {
    return { ok: false, error: "You're previewing too quickly. Wait a minute and try again." };
  }

  const printerProfileId = String(formData.get("printerProfileId") ?? "");
  const [{ data: printerProfile }, { data: settings }, { data: memberRow }] = await Promise.all([
    supabase.from("printer_profiles").select("*, printers!inner(id, organization_id)").eq("id", printerProfileId).single(),
    supabase.from("organization_settings").select("*").eq("organization_id", organizationId).single(),
    supabase.from("organization_members").select("user_code").eq("user_id", session.userId).eq("organization_id", organizationId).maybeSingle(),
  ]);
  if (!printerProfile || printerProfile.printers.organization_id !== organizationId) {
    return { ok: false, error: "Choose a printer." };
  }

  const profileBindingSide: BindingSide = printerProfile.booklet_binding_side === "right" ? "right" : "left";
  let bindingSide: BindingSide | null;
  let paperSize: string;
  if (printerProfile.output_mode === "raw") {
    const caps = printerProfile.declared_capabilities as { duplex?: boolean; staple?: boolean; booklet?: boolean } | null;
    const mapped = mapRawChoices(choices, {
      capabilities: { duplex: !!caps?.duplex, staple: !!caps?.staple, booklet: !!caps?.booklet },
      bookletBindingSide: profileBindingSide,
      stapleDefault: printerProfile.raw_staple_position === "top-right" ? "top-right" : "top-left",
      declaredPaperSizes: printerProfile.declared_paper_sizes,
    });
    ({ bindingSide, paperSize } = mapped);
  } else {
    bindingSide = mapQueueChoices(choices, { bookletBindingSide: profileBindingSide }).bindingSide;
    paperSize = String(formData.get("paperSize") ?? "letter");
  }

  const pdf = await readFormPdf(formData, { userId: session.userId, membership: { organization_id: organizationId } });
  if (!pdf.ok) return { ok: false, error: pdf.error === "Choose a PDF to upload." ? "Choose a PDF first." : pdf.error };
  const bytes = pdf.bytes;

  // The stamp only uses a user code that already exists: a preview never creates or saves anything.
  const stampSettings = normalizeStampSettings(settings as Record<string, unknown> | null);
  const code = (memberRow as { user_code?: string | null } | null)?.user_code ?? null;
  const stamp = stampSettings.enabled && code ? { text: buildStampText({ code, show: stampSettings.show, now: new Date() }), strength: stampSettings.strength } : null;

  const side: BindingSide = bindingSide ?? profileBindingSide;
  const result = await buildBookletPreviewPdf(bytes, {
    maxSizeBytes: settings?.max_upload_size_bytes ?? 52428800,
    pageRangeText: choices.pageRange.trim() === "" ? null : choices.pageRange.trim(),
    paperSize,
    bindingSide: side,
    fit: formData.get("bookletFit") === "keep" ? "keep" : "fill",
    sheet: bookletSheetChoice(formData.get("bookletSheet")),
    stamp,
  });
  if (!result.ok) return result;

  const db = createServiceRoleClient();
  const path = `gateway-intake/preview-${session.userId}/${randomUUID()}.pdf`;
  const { error: uploadError } = await db.storage.from(PRINT_JOBS_BUCKET).upload(path, result.bytes, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    logger.error("booklet preview: could not store the preview", { error: uploadError.message });
    return { ok: false, error: "The preview was built but could not be shown. Printing is not affected. Try again." };
  }
  const { data: signed, error: signError } = await db.storage.from(PRINT_JOBS_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (signError || !signed) return { ok: false, error: "The preview was built but could not be shown. Printing is not affected. Try again." };

  return {
    ok: true,
    pdfUrl: signed.signedUrl,
    bindingSide: side,
    sourcePages: result.sourcePages,
    paddedPages: result.paddedPages,
    blankPagesAdded: result.blankPagesAdded,
    sheets: result.sheets,
  };
}
