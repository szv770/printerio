"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireSession, type SessionWithMembership } from "@/lib/auth/session";
import type { Database } from "@/lib/database.types";
import { routes } from "@/lib/routes";
import { preflightPdf } from "@/lib/pdf/preflight";
import { createBookletPaddedPdf } from "@/lib/pdf/booklet";
import { imposeBookletPdf, resolvePaperSizePoints } from "@/lib/pdf/imposition";
import { computePrintMath, computeCostCents, computeBookletPadding, type PricingConfig } from "@printos/shared";
import { evaluateJobPolicy } from "@/lib/policy/build-facts";
import { adjustMonthlyUsage, getApplicableQuotaLimit } from "@/lib/quota";
import { jobFilePath, PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";

export interface SubmitJobState {
  error?: string;
  needsBookletConfirm?: {
    sourcePages: number;
    paddedPages: number;
    blankPagesAdded: number;
  };
}

const initialState: SubmitJobState = {};
export { initialState as initialSubmitJobState };

interface JobOptions {
  printerProfileId: string;
  copies: number;
  colorMode: "bw" | "color";
  duplex: boolean;
  paperSize: string;
  staple: boolean;
  booklet: boolean;
  punch: boolean;
  confirmBookletPadding: boolean;
}

/**
 * The actual job-creation pipeline - preflight, booklet imposition, print
 * math, policy evaluation, quota reservation, storage upload, the
 * print_jobs insert, and its event trail. Shared by submitPrintJobAction
 * (a fresh upload) and reprintJobAction (re-running the same pipeline
 * against a previously-uploaded file's bytes) so this logic - the actual
 * money path - exists exactly once. Redirects to the new job's status page
 * on success (via next/navigation's redirect(), which throws and is safe to
 * let propagate up through a caller); returns a SubmitJobState otherwise.
 */
async function createPrintJob(
  supabase: SupabaseClient<Database>,
  session: SessionWithMembership,
  originalBytes: Uint8Array,
  originalFileName: string,
  opts: JobOptions,
): Promise<SubmitJobState> {
  const organizationId = session.membership.organization_id;
  const { printerProfileId, copies, colorMode, duplex, paperSize, staple, booklet, punch, confirmBookletPadding } = opts;

  if (!printerProfileId) return { error: "Choose a printer." };

  // Fixed-window rate limit, checked before any expensive work (PDF parsing,
  // storage upload) - see supabase/migrations/0012_rate_limiting.sql for why
  // this has to be DB-backed rather than in-memory on Vercel. Scoped per
  // user, not per org, so one runaway script/loop can't starve the rest of
  // the organization's submit capacity either.
  const { data: withinLimit, error: rateLimitError } = await supabase.rpc("check_rate_limit", {
    p_key: `print_submit:${session.userId}`,
    p_max_count: 20,
    p_window_seconds: 300,
  });
  if (rateLimitError) {
    logger.error("rate limit check failed", { userId: session.userId, error: rateLimitError.message });
  } else if (!withinLimit) {
    return { error: "You're submitting jobs too quickly. Wait a few minutes and try again." };
  }

  const { data: printerProfile, error: profileError } = await supabase
    .from("printer_profiles")
    .select("*, printers!inner(id, organization_id)")
    .eq("id", printerProfileId)
    .single();
  if (profileError || !printerProfile || printerProfile.printers.organization_id !== organizationId) {
    return { error: "Selected printer is not available." };
  }

  const { data: settings } = await supabase
    .from("organization_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .single();
  const maxUploadBytes = settings?.max_upload_size_bytes ?? 52428800;
  const quotaBasis = (settings?.quota_basis ?? "physical_sheets") as
    | "pdf_pages"
    | "printed_sides"
    | "physical_sheets"
    | "color_weighted";
  const approvalExpiryHours = settings?.job_approval_expiry_hours ?? 72;

  // Re-checked here (not just at the original upload) since the org's limit
  // could have shrunk since - matters for reprintJobAction, a no-op re-check
  // for a fresh upload that already passed this in submitPrintJobAction.
  if (originalBytes.byteLength > maxUploadBytes) {
    const maxMb = (maxUploadBytes / (1024 * 1024)).toFixed(0);
    return { error: `File exceeds this organization's ${maxMb} MB upload limit.` };
  }

  const preflight = await preflightPdf(originalBytes, { maxSizeBytes: maxUploadBytes });
  if (!preflight.ok) return { error: preflight.reason };

  const sourcePages = preflight.pageCount;

  let derivedBytes: Uint8Array | null = null;
  let effectivePageCount = sourcePages;
  let blankPagesAdded = 0;

  if (booklet) {
    const padding = computeBookletPadding(sourcePages);
    if (padding.needsPadding && !confirmBookletPadding) {
      return {
        needsBookletConfirm: {
          sourcePages,
          paddedPages: padding.paddedPages,
          blankPagesAdded: padding.blankPagesAdded,
        },
      };
    }

    // Always pad (a no-op when already a multiple of 4) and then impose -
    // real N-up saddle-stitch imposition with per-page independent scaling
    // (docs/architecture.md sec 8), not just padding. The derived file
    // uploaded below is the fully-imposed PDF; the Agent's driver queue does
    // no booklet reflow of its own for a PrintOS-submitted booklet job.
    const padded = await createBookletPaddedPdf(originalBytes);
    effectivePageCount = padded.paddedPages;
    blankPagesAdded = padded.blankPagesAdded;
    derivedBytes = await imposeBookletPdf(padded.bytes, resolvePaperSizePoints(paperSize));
  }

  const printMath = computePrintMath({ pageCount: effectivePageCount, copies, duplex, booklet });
  const pricing = (printerProfile.pricing as unknown as PricingConfig | null) ?? null;
  const costCents = computeCostCents({
    printedSides: printMath.printedSides,
    copies,
    colorMode,
    paperSize,
    finishingStaple: staple,
    finishingBooklet: booklet,
    pricing,
  });

  const { result: policy } = await evaluateJobPolicy(supabase, {
    organizationId,
    userId: session.userId,
    role: session.membership.role as Parameters<typeof evaluateJobPolicy>[1]["role"],
    department: session.membership.department,
    printerId: printerProfile.printers.id,
    pageCount: sourcePages,
    copies,
    colorMode,
    duplex,
    paperSize,
    finishingStaple: staple,
    finishingBooklet: booklet,
    finishingPunch: punch,
    estimatedPhysicalSheets: printMath.physicalSheets,
    estimatedCostCents: costCents,
  });

  let jobStatus: "denied" | "pending_approval" | "approved" = "approved";
  if (policy.action === "deny") jobStatus = "denied";
  else if (policy.action === "require_approval") jobStatus = "pending_approval";

  if (jobStatus !== "denied") {
    const { data: groupRows } = await supabase.from("group_members").select("group_id").eq("user_id", session.userId);
    const limit = await getApplicableQuotaLimit(supabase, {
      organizationId,
      userId: session.userId,
      role: session.membership.role,
      department: session.membership.department,
      groupIds: (groupRows ?? []).map((g) => g.group_id),
    });

    const colorWeight = colorMode === "color" ? 2 : 1;
    const amounts = {
      pdfPages: sourcePages * copies,
      printedSides: printMath.printedSides,
      physicalSheets: printMath.physicalSheets,
      colorWeighted: printMath.physicalSheets * colorWeight,
    };

    const reserved = await adjustMonthlyUsage(
      supabase,
      { organizationId, userId: session.userId },
      amounts,
      quotaBasis,
      limit,
      "reserve",
    );

    if (!reserved) {
      return { error: "This job would exceed your monthly print quota. Contact your administrator." };
    }
  }

  const jobId = crypto.randomUUID();
  const originalPath = jobFilePath(organizationId, jobId, "original");

  const { error: uploadError } = await supabase.storage
    .from(PRINT_JOBS_BUCKET)
    .upload(originalPath, originalBytes, { contentType: "application/pdf" });
  if (uploadError) return { error: "Failed to store the uploaded file." };

  let derivedPath: string | null = null;
  if (derivedBytes) {
    derivedPath = jobFilePath(organizationId, jobId, "derived");
    await supabase.storage
      .from(PRINT_JOBS_BUCKET)
      .upload(derivedPath, derivedBytes, { contentType: "application/pdf" });
  }

  const now = new Date();
  const { error: insertError } = await supabase.from("print_jobs").insert({
    id: jobId,
    organization_id: organizationId,
    created_by: session.userId,
    printer_id: printerProfile.printers.id,
    printer_profile_id: printerProfile.id,
    status: jobStatus,
    original_file_path: originalPath,
    derived_file_path: derivedPath,
    original_file_name: originalFileName,
    source_pdf_pages: sourcePages,
    file_size_bytes: preflight.fileSizeBytes,
    copies,
    color_mode: colorMode,
    duplex,
    paper_size: paperSize,
    finishing: { staple, booklet, punch },
    booklet_padding_added: blankPagesAdded,
    estimated_printed_sides: printMath.printedSides,
    estimated_physical_sheets: printMath.physicalSheets,
    estimated_cost_cents: costCents,
    policy_action: policy.action,
    policy_reasons: policy.reasons,
    approved_at: jobStatus === "approved" ? now.toISOString() : null,
    expires_at:
      jobStatus === "pending_approval"
        ? new Date(now.getTime() + approvalExpiryHours * 3600 * 1000).toISOString()
        : null,
  });
  if (insertError) {
    // Never surface a raw Postgres error to a student/staff user (column
    // names, constraint details) - log server-side only and return a
    // generic message. See docs/architecture.md sec 3.2.
    logger.error("print_jobs insert failed", { jobId, organizationId, error: insertError.message });
    return { error: "Failed to create the print job. Please try again." };
  }

  const events = [
    { event_type: "JOB_CREATED" as const, metadata: {} },
    { event_type: "PDF_UPLOADED" as const, metadata: { fileName: originalFileName, fileSizeBytes: preflight.fileSizeBytes } },
    { event_type: "PREFLIGHT_COMPLETED" as const, metadata: { sourcePages, blankPagesAdded } },
    { event_type: "POLICY_EVALUATED" as const, metadata: { action: policy.action, reasons: policy.reasons } },
    {
      event_type:
        jobStatus === "denied" ? ("DENIED" as const) : jobStatus === "pending_approval" ? ("APPROVAL_REQUIRED" as const) : ("APPROVED" as const),
      metadata: {},
    },
  ];
  await supabase.from("print_job_events").insert(
    events.map((e) => ({
      job_id: jobId,
      event_type: e.event_type,
      actor_type: "user" as const,
      actor_id: session.userId,
      metadata: e.metadata,
    })),
  );

  redirect(routes.job(jobId));
}

export async function submitPrintJobAction(_prev: SubmitJobState, formData: FormData): Promise<SubmitJobState> {
  const session = await requireSession();
  if (!session.membership) return { error: "You are not a member of any organization yet." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a PDF to upload." };
  }

  const supabase = await createClient();
  const originalBytes = new Uint8Array(await file.arrayBuffer());

  return createPrintJob(supabase, session as SessionWithMembership, originalBytes, file.name, {
    printerProfileId: String(formData.get("printerProfileId") ?? ""),
    copies: Math.max(1, parseInt(String(formData.get("copies") ?? "1"), 10) || 1),
    colorMode: formData.get("colorMode") === "color" ? "color" : "bw",
    duplex: formData.get("duplex") === "on",
    paperSize: String(formData.get("paperSize") ?? "letter"),
    staple: formData.get("staple") === "on",
    booklet: formData.get("booklet") === "on",
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
  const session = await requireSession();
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

  return createPrintJob(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    copies: job.copies,
    colorMode: job.color_mode as "bw" | "color",
    duplex: job.duplex,
    paperSize: job.paper_size,
    staple: finishing.staple,
    booklet: finishing.booklet,
    punch: finishing.punch,
    confirmBookletPadding: true,
  });
}
