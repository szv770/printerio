"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireSessionOrRedirect, type SessionWithMembership } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { parseChoices } from "@/lib/print-choices";
import { parseLayoutForm } from "@/lib/print-layout-form";
import { pipelineSettingsFromJob } from "@/lib/jobs/print-again";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { readFormPdf } from "./form-pdf";
import { BOOKLET_BINDING_REASON } from "@/lib/gateway/ipp-choices";
import { createPrintJob, type JobOptions } from "@/lib/jobs/create-print-job";
import { bookletSheetChoice } from "@printio/pdf/booklet-build";
import { prepareViaServerEnabled, submitViaPrintServer } from "@/lib/prepare/submit";
import { lastChoicesFromSubmit, writeLastChoices } from "@/lib/print-preferences";

export interface SubmitJobState {
  error?: string;
  /** Errors that belong next to one field of the form (the page range today). */
  fieldErrors?: { pageRange?: string };
  needsBookletConfirm?: {
    sourcePages: number;
    paddedPages: number;
    blankPagesAdded: number;
  };
}

/**
 * Runs the shared pipeline (lib/jobs/create-print-job.ts) for a signed-in member and turns its result into what
 * the upload form expects: redirect to the new job's status page on success (next/navigation's redirect() throws
 * and is safe to let propagate), a SubmitJobState otherwise. Shared by submitPrintJobAction (a fresh upload) and
 * reprintJobAction (re-running the pipeline against a previously-uploaded file's bytes).
 *
 * Authorization model (migration 0034): the member's own client is used only to READ (RLS select, plus the explicit
 * created_by / organization filters the callers add). Every WRITE - quota, the storage upload, the print_jobs row,
 * its events - runs through the service-role client, passed down as opts.writeClient, AFTER the caller has been
 * authenticated by requireSessionOrRedirect(). organization_id and created_by come from that session inside
 * createPrintJob, and the job's status and approval fields are decided there by the policy engine: nothing in the
 * form can set them.
 */
async function runPipeline(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: SessionWithMembership,
  originalBytes: Uint8Array,
  originalFileName: string,
  opts: JobOptions,
  /** Runs once the job exists, before the redirect. Must never throw (see writeLastChoices). */
  afterCreated?: () => Promise<void>,
): Promise<SubmitJobState> {
  const result = await createPrintJob(supabase, session, originalBytes, originalFileName, { ...opts, writeClient: createServiceRoleClient() });
  if (result.ok) {
    await afterCreated?.();
    redirect(routes.job(result.jobId));
  }
  if (result.kind === "needs_booklet_confirm") return { needsBookletConfirm: result.needsBookletConfirm };
  return { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) };
}

export async function submitPrintJobAction(_prev: SubmitJobState, formData: FormData): Promise<SubmitJobState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "You are not a member of any organization yet." };

  const supabase = await createClient();
  // A school switched on for it has its PDF prepared by its own print server (lib/prepare). Off (the default) = the unchanged path below.
  const viaServer = await prepareViaServerEnabled(createServiceRoleClient(), session.membership.organization_id);

  const pdf = viaServer ? null : await readFormPdf(formData, session as SessionWithMembership & { membership: { organization_id: string } });
  if (pdf && !pdf.ok) return { error: pdf.error };

  // The form contract: sides / staple / booklet / copies / pageRange / printerProfileId. colorMode,
  // paperSize and punch are only sent for queue printers (raw printers derive them on the server).
  const parsedChoices = parseChoices((name) => formData.get(name));
  if (!parsedChoices.ok) return { error: parsedChoices.reason };

  // Pages per sheet / one page repeated. A booklet is its own layout, so asking for both is refused here (the form mirrors this).
  const parsedLayout = parseLayoutForm((name) => formData.get(name), parsedChoices.choices.booklet);
  if (!parsedLayout.ok) return { error: parsedLayout.reason };

  const jobOptions: JobOptions = {
    printerProfileId: String(formData.get("printerProfileId") ?? ""),
    choices: parsedChoices.choices,
    colorMode: formData.get("colorMode") === "color" ? "color" : "bw",
    paperSize: String(formData.get("paperSize") ?? "letter"),
    punch: formData.get("punch") === "on",
    confirmBookletPadding: formData.get("confirmBookletPadding") === "true",
    bookletFit: formData.get("bookletFit") === "keep" ? "keep" : "fill",
    bookletSheet: bookletSheetChoice(formData.get("bookletSheet")),
    ...(parsedLayout.layout ? { layout: parsedLayout.layout } : {}),
  };
  // "Remember my last print choices": only writes when the member switched it on (and never errors the submit).
  const afterCreated = () =>
    writeLastChoices(
      supabase,
      session.userId,
      lastChoicesFromSubmit({
        printerProfileId: jobOptions.printerProfileId,
        sides: parsedChoices.choices.sides,
        staple: parsedChoices.choices.staple,
        booklet: parsedChoices.choices.booklet,
        copies: parsedChoices.choices.copies,
        colorMode: jobOptions.colorMode,
        paperSize: jobOptions.paperSize,
        punch: jobOptions.punch,
        bookletFit: jobOptions.bookletFit ?? "fill",
        bookletSheet: jobOptions.bookletSheet ?? "letter",
      }),
    );
  if (viaServer) {
    const stagedPath = formData.get("stagedPath");
    const name = formData.get("fileName");
    const file = formData.get("file");
    let bytes: Uint8Array | null = null;
    if (!(typeof stagedPath === "string" && stagedPath !== "") && file instanceof File && file.size > 0) {
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        return { error: "Your file didn't finish uploading. Check your connection and submit again." };
      }
    }
    const fileName = typeof stagedPath === "string" && stagedPath !== ""
      ? (typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 200) : "upload.pdf")
      : file instanceof File ? file.name : "upload.pdf";
    const out = await submitViaPrintServer(
      supabase,
      createServiceRoleClient(),
      session as SessionWithMembership,
      { stagedPath: typeof stagedPath === "string" && stagedPath !== "" ? stagedPath : null, bytes, fileName },
      jobOptions,
    );
    if (!out.ok) return { error: out.error, ...(out.fieldErrors ? { fieldErrors: out.fieldErrors } : {}) };
    await afterCreated();
    redirect(routes.preparing(out.prepareJobId));
  }
  if (!pdf || !pdf.ok) return { error: "Choose a PDF to upload." };
  return runPipeline(supabase, session as SessionWithMembership, pdf.bytes, pdf.fileName, jobOptions, afterCreated);
}

/**
 * "Print again" - re-runs the exact same pipeline against a PREVIOUSLY
 * uploaded job's original file, reusing its saved settings, without
 * requiring the user to re-select the file. The old job's settings/file
 * path are read server-side from a row scoped to this user - never taken
 * from the client - so this cannot be used to reprint someone else's job by
 * guessing a jobId. Booklet padding is silently reconfirmed (rather than
 * showing the interstitial again) since this exact document + booklet
 * combination already went through that confirmation once, when the job
 * being reprinted was first submitted.
 */
export async function reprintJobAction(_prev: SubmitJobState, formData: FormData): Promise<SubmitJobState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "You are not a member of any organization yet." };
  const organizationId = session.membership.organization_id;

  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return { error: "Missing job." };

  const supabase = await createClient();
  const { data: job, error: jobError } = await supabase
    .from("print_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("created_by", session.userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (jobError || !job) return { error: "Job not found." };

  // Retention (or the owner) may already have deleted the stored file; say so plainly instead of failing a download.
  if (job.files_purged_at || !job.original_file_path) {
    return {
      error:
        "This job's file was removed to save space (finished jobs are cleared after a few days). Print again from the original document using New print job.",
    };
  }

  // Ownership is proven above (created_by + organization from the session), so the file itself is fetched with the
  // service role: members have no direct read on a bucket path (migration 0034).
  const service = createServiceRoleClient();
  const { data: fileData, error: downloadError } = await service.storage.from(PRINT_JOBS_BUCKET).download(job.original_file_path);
  if (downloadError || !fileData) {
    return { error: "The original file for this job is no longer available. Print again from the original document using New print job." };
  }
  const originalBytes = new Uint8Array(await fileData.arrayBuffer());

  // Everything the job used (sides + short-edge flip, staple corner / two-staple style, punch, booklet side / fit /
  // sheet, page range, colour, paper) goes back through the same pipeline, applied to the untouched original. An
  // older job that never stored a staple corner / binding side falls back to the printer's own default.
  const settings = pipelineSettingsFromJob(job);

  return runPipeline(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    choices: settings.choices,
    colorMode: settings.colorMode,
    paperSize: settings.paperSize,
    punch: settings.punch,
    confirmBookletPadding: true,
    bookletFit: settings.bookletFit,
    bookletSheet: bookletSheetChoice(settings.bookletSheet),
  });
}

/**
 * "Finish this booklet" - the one-tap card on a held booklet job (the print dialog can ask for a booklet but not
 * for left or right binding, so the IPP gateway holds it with that question). The member's choice goes through the
 * same pipeline as every other job, applied to the untouched original, so imposition (left, or the mirrored right
 * layout) and the raw-path PJL come out exactly as for a web upload with that side. Only after the new job exists
 * is the held one closed (guarded on it still being held; a held job reserves no quota), so a failure leaves the
 * held job and the question where they were. Everything is read server-side from a row scoped to the caller.
 */
export async function finishHeldBookletAction(_prev: SubmitJobState, formData: FormData): Promise<SubmitJobState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "You are not a member of any organization yet." };
  const organizationId = session.membership.organization_id;

  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return { error: "Missing job." };
  const side = String(formData.get("bindingSide") ?? "");
  if (side !== "left" && side !== "right") return { error: "Choose left or right binding." };

  const supabase = await createClient();
  const { data: job, error: jobError } = await supabase
    .from("print_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("created_by", session.userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (jobError || !job) return { error: "Job not found." };

  const finishing = job.finishing as { booklet?: boolean; punch?: boolean; bookletFit?: string; bookletSheet?: string } | null;
  if (job.status !== "held" || !finishing?.booklet || job.held_reason !== BOOKLET_BINDING_REASON) {
    return { error: "This job is no longer waiting for your choice." };
  }

  const service = createServiceRoleClient();
  const { data: fileData, error: downloadError } = await service.storage.from(PRINT_JOBS_BUCKET).download(job.original_file_path);
  if (downloadError || !fileData) return { error: "The original file for this job is no longer available." };
  const originalBytes = new Uint8Array(await fileData.arrayBuffer());

  const result = await createPrintJob(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    choices: { sides: "two", staple: "none", booklet: side, copies: job.copies, pageRange: job.page_range ?? "" },
    colorMode: job.color_mode as "bw" | "color",
    paperSize: job.paper_size,
    punch: false,
    confirmBookletPadding: true,
    bookletFit: finishing.bookletFit === "keep" ? "keep" : "fill",
    bookletSheet: bookletSheetChoice(finishing.bookletSheet),
    writeClient: service,
    ...(job.source === "ipp" ? { source: "ipp" as const, deviceId: job.device_id ?? undefined } : {}),
  });
  if (!result.ok) {
    if (result.kind === "needs_booklet_confirm") return { needsBookletConfirm: result.needsBookletConfirm };
    return { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) };
  }

  // Service role (members cannot update print_jobs), so the guards live in the WHERE clause: still held, the
  // caller's own job, in the caller's own organization. The only value ever written is "cancelled".
  const { data: closed } = await service
    .from("print_jobs")
    .update({ status: "cancelled" })
    .eq("id", job.id)
    .eq("status", "held")
    .eq("created_by", session.userId)
    .eq("organization_id", organizationId)
    .select("id");
  if (closed && closed.length > 0) {
    await service.from("print_job_events").insert({
      job_id: job.id,
      event_type: "JOB_CANCELLED",
      actor_type: "user",
      actor_id: session.userId,
      metadata: { reason: "binding chosen", replacedBy: result.jobId },
    });
  }
  redirect(routes.job(result.jobId));
}
