"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect, type SessionWithMembership } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { parseChoices, type PrintChoices } from "@/lib/print-choices";
import { PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { BOOKLET_BINDING_REASON } from "@/lib/gateway/ipp-choices";
import { createPrintJob, type JobOptions } from "@/lib/jobs/create-print-job";

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
 */
async function runPipeline(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: SessionWithMembership,
  originalBytes: Uint8Array,
  originalFileName: string,
  opts: JobOptions,
): Promise<SubmitJobState> {
  const result = await createPrintJob(supabase, session, originalBytes, originalFileName, opts);
  if (result.ok) redirect(routes.job(result.jobId));
  if (result.kind === "needs_booklet_confirm") return { needsBookletConfirm: result.needsBookletConfirm };
  return { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) };
}

export async function submitPrintJobAction(_prev: SubmitJobState, formData: FormData): Promise<SubmitJobState> {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return { error: "You are not a member of any organization yet." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a PDF to upload." };
  }

  const supabase = await createClient();

  // A File handed to a Server Action can still fail to read - a multipart body
  // cut short mid-upload (a phone dropping off wifi is the everyday case) is
  // the one that actually happens. Uncaught, that threw out of the action and
  // rendered the error boundary instead of telling the user to try again.
  let originalBytes: Uint8Array;
  try {
    originalBytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    logger.error("could not read the uploaded file", {
      userId: session.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: "Your file didn't finish uploading. Check your connection and submit again." };
  }

  // The form contract: sides / staple / booklet / copies / pageRange / printerProfileId. colorMode,
  // paperSize and punch are only sent for queue printers (raw printers derive them on the server).
  const parsedChoices = parseChoices((name) => formData.get(name));
  if (!parsedChoices.ok) return { error: parsedChoices.reason };

  return runPipeline(supabase, session as SessionWithMembership, originalBytes, file.name, {
    printerProfileId: String(formData.get("printerProfileId") ?? ""),
    choices: parsedChoices.choices,
    colorMode: formData.get("colorMode") === "color" ? "color" : "bw",
    paperSize: String(formData.get("paperSize") ?? "letter"),
    punch: formData.get("punch") === "on",
    confirmBookletPadding: formData.get("confirmBookletPadding") === "true",
  });
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

  const { data: fileData, error: downloadError } = await supabase.storage
    .from(PRINT_JOBS_BUCKET)
    .download(job.original_file_path);
  if (downloadError || !fileData) return { error: "The original file for this job is no longer available." };
  const originalBytes = new Uint8Array(await fileData.arrayBuffer());

  const finishing = job.finishing as { staple: boolean; booklet: boolean; punch: boolean };

  // The stored per-job choices go back through the same pipeline, applied to the untouched original. An
  // older job that never stored a staple corner / binding side falls back to the printer's own default.
  const choices: PrintChoices = {
    sides: job.duplex ? "two" : "one",
    staple: finishing.staple ? (job.staple_position === "top-left" || job.staple_position === "top-right" ? job.staple_position : "profile") : "none",
    booklet: finishing.booklet
      ? job.booklet_binding_side === "left" || job.booklet_binding_side === "right"
        ? job.booklet_binding_side
        : "profile"
      : "none",
    copies: job.copies,
    pageRange: job.page_range ?? "",
  };

  return runPipeline(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    choices,
    colorMode: job.color_mode as "bw" | "color",
    paperSize: job.paper_size,
    punch: finishing.punch,
    confirmBookletPadding: true,
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

  const finishing = job.finishing as { booklet?: boolean; punch?: boolean } | null;
  if (job.status !== "held" || !finishing?.booklet || job.held_reason !== BOOKLET_BINDING_REASON) {
    return { error: "This job is no longer waiting for your choice." };
  }

  const { data: fileData, error: downloadError } = await supabase.storage.from(PRINT_JOBS_BUCKET).download(job.original_file_path);
  if (downloadError || !fileData) return { error: "The original file for this job is no longer available." };
  const originalBytes = new Uint8Array(await fileData.arrayBuffer());

  const result = await createPrintJob(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    choices: { sides: "two", staple: "none", booklet: side, copies: job.copies, pageRange: job.page_range ?? "" },
    colorMode: job.color_mode as "bw" | "color",
    paperSize: job.paper_size,
    punch: false,
    confirmBookletPadding: true,
    ...(job.source === "ipp" ? { source: "ipp" as const, deviceId: job.device_id ?? undefined } : {}),
  });
  if (!result.ok) {
    if (result.kind === "needs_booklet_confirm") return { needsBookletConfirm: result.needsBookletConfirm };
    return { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) };
  }

  const { data: closed } = await supabase
    .from("print_jobs")
    .update({ status: "cancelled" })
    .eq("id", job.id)
    .eq("status", "held")
    .eq("created_by", session.userId)
    .select("id");
  if (closed && closed.length > 0) {
    await supabase.from("print_job_events").insert({
      job_id: job.id,
      event_type: "JOB_CANCELLED",
      actor_type: "user",
      actor_id: session.userId,
      metadata: { reason: "binding chosen", replacedBy: result.jobId },
    });
  }
  redirect(routes.job(result.jobId));
}
