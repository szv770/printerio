"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireSessionOrRedirect } from "@/lib/auth/session";
import { parseChoices, mapRawChoices, mapQueueChoices, type BindingSide } from "@/lib/print-choices";
import { buildBookletPreviewPdf } from "@/lib/jobs/booklet-preview";
import { bookletSheetChoice } from "@/lib/pdf/booklet-build";
import { buildStampText, normalizeStampSettings } from "@/lib/jobs/user-code";
import { logger } from "@/lib/logger";

export type BookletPreviewState =
  | {
      ok: true;
      /** The imposed booklet PDF (what would be sent to the printer), base64. Nothing is stored. */
      pdfBase64: string;
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
 * submitting; the file is size-limited by the organization's upload limit (and a smaller preview ceiling).
 */
export async function previewBookletAction(formData: FormData): Promise<BookletPreviewState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { ok: false, error: "You are not a member of any organization yet." };
  const organizationId = session.membership.organization_id;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a PDF first." };

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

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, error: "Your file didn't finish uploading. Check your connection and try again." };
  }

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
  return {
    ok: true,
    pdfBase64: Buffer.from(result.bytes).toString("base64"),
    bindingSide: side,
    sourcePages: result.sourcePages,
    paddedPages: result.paddedPages,
    blankPagesAdded: result.blankPagesAdded,
    sheets: result.sheets,
  };
}
