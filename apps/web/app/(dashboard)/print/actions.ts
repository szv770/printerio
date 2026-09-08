"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireSessionOrRedirect, type SessionWithMembership } from "@/lib/auth/session";
import type { Database } from "@/lib/database.types";
import { routes } from "@/lib/routes";
import { preflightPdf } from "@/lib/pdf/preflight";
import { createBookletPaddedPdf } from "@/lib/pdf/booklet";
import { imposeBookletPdf, resolvePaperSizePoints } from "@/lib/pdf/imposition";
import { computePrintMath, computeCostCents, computeBookletPadding, type PricingConfig, type OrgRole } from "@printio/shared";
import { evaluateJobPolicy } from "@/lib/policy/build-facts";
import { didBypassChangeOutcome, isAdminExemptFromRestrictions } from "@/lib/policy/admin-bypass";
import { adjustMonthlyUsage, usageAmountsForJob, type UsageAmounts } from "@/lib/quota";
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
  /** Per-job override of the target printer_profile's own
   *  booklet_binding_side (PrintForm.tsx's binding-side select, shown only
   *  for a booklet-capable profile). Undefined = use the profile's stored
   *  default - see the bindingSide resolution below. */
  bindingSideOverride?: "left" | "right";
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
  const { printerProfileId, copies, colorMode, duplex, paperSize, staple, booklet, punch, confirmBookletPadding, bindingSideOverride } = opts;

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

  // Independent lookups - the profile doesn't gate the settings read or vice
  // versa - so they overlap instead of costing two sequential round trips
  // while the user waits with their file already uploaded.
  const [{ data: printerProfile, error: profileError }, { data: settings }] = await Promise.all([
    supabase.from("printer_profiles").select("*, printers!inner(id, organization_id)").eq("id", printerProfileId).single(),
    supabase.from("organization_settings").select("*").eq("organization_id", organizationId).single(),
  ]);
  if (profileError || !printerProfile || printerProfile.printers.organization_id !== organizationId) {
    return { error: "Selected printer is not available." };
  }

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
    // no booklet reflow of its own for a Printio-submitted booklet job.
    const padded = await createBookletPaddedPdf(originalBytes);
    effectivePageCount = padded.paddedPages;
    blankPagesAdded = padded.blankPagesAdded;

    // Defaults to the target profile's own stored binding side
    // (printer_profiles.booklet_binding_side) - PrintForm.tsx's per-job
    // override, when present, wins for this one job only, without touching
    // the profile's own default (docs/architecture.md sec 8).
    const bindingSide: "left" | "right" =
      bindingSideOverride ?? (printerProfile.booklet_binding_side === "right" ? "right" : "left");
    derivedBytes = await imposeBookletPdf(padded.bytes, resolvePaperSizePoints(paperSize), bindingSide);
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

  const { result: policy, quotaLimit, adminsBypassRestrictions } = await evaluateJobPolicy(supabase, {
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

  // An org_admin's own submission bypasses a deny/require_approval outcome
  // (and, below, the quota block) by default - see lib/policy/admin-bypass.ts.
  // policy.action/policy.reasons are still stored on the job exactly as
  // evaluated; policyBypassed is only the audit flag for "this outcome was
  // overridden", shown to the admin as a warning rather than hidden.
  const adminExempt = isAdminExemptFromRestrictions(session.membership.role as OrgRole, adminsBypassRestrictions);
  const policyBypassed = didBypassChangeOutcome(adminExempt, policy.action);

  let jobStatus: "denied" | "pending_approval" | "approved" = "approved";
  if (!adminExempt) {
    if (policy.action === "deny") jobStatus = "denied";
    else if (policy.action === "require_approval") jobStatus = "pending_approval";
  }

  // Reused from the policy evaluation above, which already had to resolve the
  // caller's groups and applicable limit to build its quota fact - no second
  // group_members/quotas round trip.
  //
  // usageAmountsForJob (not an inline calculation) so what is reserved here
  // is by construction the same number the release/consume paths later refund
  // or charge - see lib/quota.ts.
  const reservedAmounts: UsageAmounts = usageAmountsForJob({
    organizationId,
    userId: session.userId,
    sourcePdfPages: sourcePages,
    copies,
    estimatedPrintedSides: printMath.printedSides,
    estimatedPhysicalSheets: printMath.physicalSheets,
    colorMode,
  });

  if (jobStatus !== "denied") {
    // An admin-exempt submission is never allowed to fail this reserve - a
    // null limit tells adjust_monthly_usage's reserve mode to always
    // succeed (supabase/migrations/0010_quota_functions.sql) while still
    // recording the usage for reporting, rather than skipping the call
    // entirely and leaving monthly_usage silently unaware of the job.
    const reserved = await adjustMonthlyUsage(
      supabase,
      { organizationId, userId: session.userId },
      reservedAmounts,
      quotaBasis,
      adminExempt ? null : quotaLimit,
      "reserve",
    );

    if (!reserved) {
      return { error: "This job would exceed your monthly print quota. Contact your administrator." };
    }
  }

  const jobId = crypto.randomUUID();
  const originalPath = jobFilePath(organizationId, jobId, "original");
  const derivedPath = derivedBytes ? jobFilePath(organizationId, jobId, "derived") : null;

  /**
   * Undoes the side effects this function has already committed when a later
   * step fails. Without this, a failure between "reserve quota" and "insert
   * row" silently charged the user's monthly quota for a job that does not
   * exist (repeated failures could burn a student's whole month) and left
   * uploaded PDFs orphaned in storage forever - the retention sweep walks
   * print_jobs rows, so an object with no row is never reclaimed.
   * Best-effort: a rollback that itself fails is logged, never surfaced on
   * top of the error the user is already being shown.
   */
  async function rollback(uploadedPaths: string[]) {
    try {
      if (uploadedPaths.length > 0) await supabase.storage.from(PRINT_JOBS_BUCKET).remove(uploadedPaths);
      if (jobStatus !== "denied") {
        await adjustMonthlyUsage(
          supabase,
          { organizationId, userId: session.userId },
          reservedAmounts,
          quotaBasis,
          quotaLimit,
          "release",
        );
      }
    } catch (err) {
      logger.error("failed to roll back a partially-created print job", {
        jobId,
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Both objects are independent writes to distinct keys, so they upload
  // concurrently rather than one after the other - on a booklet job that
  // halves the storage wait the user sits through after submitting.
  const [originalUpload, derivedUpload] = await Promise.all([
    supabase.storage.from(PRINT_JOBS_BUCKET).upload(originalPath, originalBytes, { contentType: "application/pdf" }),
    derivedBytes && derivedPath
      ? supabase.storage.from(PRINT_JOBS_BUCKET).upload(derivedPath, derivedBytes, { contentType: "application/pdf" })
      : Promise.resolve({ error: null }),
  ]);
  // A failed derived upload used to be swallowed entirely: the row was still
  // written pointing at a derived_file_path that did not exist, so the job
  // looked fine here and then failed at the Agent with nothing explaining why.
  if (originalUpload.error || derivedUpload.error) {
    const uploaded = [
      ...(originalUpload.error ? [] : [originalPath]),
      ...(derivedUpload.error || !derivedPath ? [] : [derivedPath]),
    ];
    logger.error("print job storage upload failed", {
      jobId,
      organizationId,
      error: (originalUpload.error ?? derivedUpload.error)?.message,
    });
    await rollback(uploaded);
    return { error: "Could not upload your document. Check your connection and submit again." };
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
    policy_bypassed_for_admin: policyBypassed,
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
    await rollback([originalPath, ...(derivedPath ? [derivedPath] : [])]);
    return { error: "Could not create the print job. Your file is still selected - submit again." };
  }

  const events = [
    { event_type: "JOB_CREATED" as const, metadata: {} },
    { event_type: "PDF_UPLOADED" as const, metadata: { fileName: originalFileName, fileSizeBytes: preflight.fileSizeBytes } },
    { event_type: "PREFLIGHT_COMPLETED" as const, metadata: { sourcePages, blankPagesAdded } },
    {
      event_type: "POLICY_EVALUATED" as const,
      metadata: { action: policy.action, reasons: policy.reasons, bypassedForAdmin: policyBypassed },
    },
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
  const session = await requireSessionOrRedirect();
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
    bindingSideOverride: parseBindingSideOverride(formData),
  });
}

/** Parses PrintForm.tsx's optional per-job booklet binding-side override -
 *  only present (and only meaningful) when a booklet-capable profile is
 *  selected; absent means "use the target profile's own default" (resolved
 *  in createPrintJob). */
function parseBindingSideOverride(formData: FormData): "left" | "right" | undefined {
  const raw = formData.get("bookletBindingSide");
  return raw === "left" || raw === "right" ? raw : undefined;
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

  return createPrintJob(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    copies: job.copies,
    colorMode: job.color_mode as "bw" | "color",
    duplex: job.duplex,
    paperSize: job.paper_size,
    staple: finishing.staple,
    booklet: finishing.booklet,
    punch: finishing.punch,
    // No stored per-job binding-side override to reuse (print_jobs doesn't
    // carry one) - reprinting a booklet job resolves against the target
    // profile's CURRENT booklet_binding_side default, same as any other
    // fresh submission to that profile.
    confirmBookletPadding: true,
  });
}
