import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PrepareJobParams } from "@printio/pdf/prepare-wire";
import { bookletSheetChoice } from "@printio/pdf/booklet-build";
import { checkSubmitLimits, resolveJobPlan, type CreatePrintJobErrorCode, type JobOptions, type JobSession } from "@/lib/jobs/create-print-job";
import { ensureMemberUserCode } from "@/lib/jobs/ensure-user-code";
import { buildStampText, normalizeStampSettings } from "@/lib/jobs/user-code";
import { stagedPdfSize } from "@/lib/jobs/staged-upload";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { MAX_PARAMS_BYTES, PREPARE_KIND } from "./prepare-jobs";

/**
 * Step one of the print-server path (docs/PREPARE-JOBS-DESIGN.md, plan P2b): the website decides everything it can WITHOUT opening the PDF, records a
 * prepare job for the person's own print server, and returns at once. No PDF library runs here and the file is never loaded into memory (it is
 * already in storage: the browser uploaded it straight there, and only its listed size is read).
 *
 * The prepare job's id is also the id the print job will get when it is finished, so finishing twice cannot make two jobs.
 */
export type IntakeResult =
  | { ok: true; prepareJobId: string }
  | { ok: false; kind: "error"; error: string; code: CreatePrintJobErrorCode; fieldErrors?: { pageRange?: string } };

const fail = (error: string, code: CreatePrintJobErrorCode): IntakeResult => ({ ok: false, kind: "error", error, code });
const NOT_THERE = "Your file didn't finish uploading. Check your connection and submit again.";

export async function intakePrintJob(
  supabase: SupabaseClient<Database>,
  session: JobSession,
  stagedPath: string,
  originalFileName: string,
  opts: JobOptions,
  /** Whose folder the staged file is in: the member for a browser upload (the default), the device for a phone print-dialog upload. */
  stagedOwnerId: string = session.userId,
): Promise<IntakeResult> {
  const writer = opts.writeClient ?? supabase;
  const organizationId = session.membership.organization_id;

  if (!opts.printerProfileId) return fail("Choose a printer.", "invalid_request");
  const limited = await checkSubmitLimits(writer, session);
  if (limited && !limited.ok && limited.kind === "error") return { ok: false, kind: "error", error: limited.error, code: limited.code };

  // The file is already in storage: only its size is looked at, never its bytes.
  const size = await stagedPdfSize(writer, stagedOwnerId, stagedPath);
  if (size === null) return fail(NOT_THERE, "storage_failed");

  const planned = await resolveJobPlan(supabase, session, size, opts);
  if (!planned.ok) {
    if (planned.result.ok === false && planned.result.kind === "error") {
      await writer.storage.from(PRINT_JOBS_BUCKET).remove([stagedPath]); // refused: do not leave the upload lying around
      return { ok: false, kind: "error", error: planned.result.error, code: planned.result.code, ...(planned.result.fieldErrors ? { fieldErrors: planned.result.fieldErrors } : {}) };
    }
    return fail("Something went wrong. Try again.", "invalid_request");
  }
  const plan = planned.plan;

  // The user code stamp text is built here (it may save the member's code in the database), and only for a job that is not held: the print
  // server has no database. A failure only means no stamp (losing a print is worse than losing a label).
  const stampSettings = normalizeStampSettings(plan.settings as Record<string, unknown> | null);
  let stamp: PrepareJobParams["pdf"]["stamp"] = null;
  if (stampSettings.enabled && plan.heldReason === null) {
    try {
      const member = (plan.memberRow as { user_code?: string | null; profiles?: { display_name?: string | null; email?: string | null } | null } | null) ?? null;
      const code = await ensureMemberUserCode(writer, {
        organizationId,
        userId: session.userId,
        displayName: member?.profiles?.display_name ?? null,
        email: member?.profiles?.email ?? null,
        stored: member?.user_code ?? null,
      });
      stamp = { text: buildStampText({ code, show: stampSettings.show, now: new Date() }), strength: stampSettings.strength };
    } catch (err) {
      logger.error("user code stamp could not be prepared; the job goes through without it", { organizationId, userId: session.userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const prepareJobId = randomUUID();
  const params: PrepareJobParams = {
    v: 1,
    pdf: {
      maxUploadBytes: plan.maxUploadBytes,
      colorMode: plan.colorMode,
      heldReason: plan.heldReason,
      ...(opts.forcedHeldReason ? { forcedHeldReason: opts.forcedHeldReason } : {}),
      pageRangeText: opts.choices.pageRange.trim() === "" ? null : opts.choices.pageRange.trim(),
      booklet: plan.booklet,
      bookletOptions: { paperSize: plan.paperSize, bindingSide: plan.bindingSide ?? plan.profileBindingSide, fit: plan.bookletFit, sheet: bookletSheetChoice(plan.bookletSheet) },
      confirmBookletPadding: opts.confirmBookletPadding,
      stamp,
      allowType3Fonts: process.env.PRINTIO_ALLOW_TYPE3_FONTS === "1",
      logContext: { organizationId, printerProfileId: opts.printerProfileId, userId: session.userId },
    },
    finish: {
      originalFileName,
      options: {
        printerProfileId: opts.printerProfileId,
        choices: opts.choices as unknown as Record<string, unknown>,
        colorMode: opts.colorMode,
        paperSize: opts.paperSize,
        punch: opts.punch,
        confirmBookletPadding: opts.confirmBookletPadding,
        ...(opts.bookletFit ? { bookletFit: opts.bookletFit } : {}),
        ...(opts.bookletSheet ? { bookletSheet: opts.bookletSheet } : {}),
        ...(opts.forcedHeldReason ? { forcedHeldReason: opts.forcedHeldReason } : {}),
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
        ...(opts.ippUserAgent ? { ippUserAgent: opts.ippUserAgent } : {}),
      },
    },
  };
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_PARAMS_BYTES) {
    return fail("These print choices are too long to process. Shorten the page range and try again.", "invalid_request");
  }

  const { error } = await writer.from("server_jobs").insert({
    id: prepareJobId,
    kind: PREPARE_KIND,
    organization_id: organizationId,
    requested_by: session.userId,
    params: params as never,
    dedupe_key: `prepare:${prepareJobId}`,
    source_path: stagedPath,
    status: "queued",
  });
  if (error) {
    logger.error("could not record a prepare job", { organizationId, userId: session.userId, error: error.message });
    return fail("Could not start preparing your file. Your file is still selected - submit again.", "insert_failed");
  }
  return { ok: true, prepareJobId };
}
