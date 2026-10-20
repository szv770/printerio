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
import { computePrintMath, computeCostCents, computeBookletPadding, type PolicyAction, type PricingConfig, type OrgRole } from "@printio/shared";
import { createPageSubsetPdf } from "@/lib/pdf/page-subset";
import { checkQueueCapabilities, mapQueueChoices, mapRawChoices, parseChoices, planPageSubset, type BindingSide, type PrintChoices } from "@/lib/print-choices";
import { evaluateJobPolicy } from "@/lib/policy/build-facts";
import { didBypassChangeOutcome, isAdminExemptFromRestrictions } from "@/lib/policy/admin-bypass";
import { adjustMonthlyUsage, usageAmountsForJob, type UsageAmounts } from "@/lib/quota";
import { jobFilePath, PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";

/** A held job waits for its sender (or an admin) for this long before it is cancelled with a note. */
const HELD_EXPIRY_HOURS = 7 * 24;

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

interface JobOptions {
  printerProfileId: string;
  /** The upload page's plain choices (sides / staple / booklet / copies / page range). */
  choices: PrintChoices;
  /** Queue-mode printers only: raw printers hide these controls, and the server derives them itself. */
  colorMode: "bw" | "color";
  paperSize: string;
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
  const { printerProfileId, choices, confirmBookletPadding } = opts;

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

  // What the member's plain choices mean for THIS printer. A printer that prints on the raw port gets its
  // colour and paper size from the server (those controls are hidden for it), and anything the shared PJL
  // builder cannot map comes back as heldReason: the job is held for the member instead of printing
  // something else. Queue printers keep their plain on/off flags.
  const profileBindingSide: BindingSide = printerProfile.booklet_binding_side === "right" ? "right" : "left";
  let duplex: boolean;
  let staple: boolean;
  let booklet: boolean;
  let punch: boolean;
  let colorMode: "bw" | "color";
  let paperSize: string;
  let staplePosition: "top-left" | "top-right" | null;
  let bindingSide: BindingSide | null;
  let heldReason: string | null = null;
  const copies = choices.copies;
  if (printerProfile.output_mode === "raw") {
    const caps = printerProfile.declared_capabilities as { duplex?: boolean; staple?: boolean; booklet?: boolean } | null;
    const mapped = mapRawChoices(choices, {
      capabilities: { duplex: !!caps?.duplex, staple: !!caps?.staple, booklet: !!caps?.booklet },
      bookletBindingSide: profileBindingSide,
      stapleDefault: printerProfile.raw_staple_position === "top-right" ? "top-right" : "top-left",
      declaredPaperSizes: printerProfile.declared_paper_sizes,
    });
    ({ duplex, colorMode, paperSize, staplePosition, bindingSide, heldReason } = mapped);
    staple = mapped.finishing.staple;
    booklet = mapped.finishing.booklet;
    punch = false; // the raw builder has no punch setting, so it is never requested
  } else {
    const mapped = mapQueueChoices(choices, { bookletBindingSide: profileBindingSide });
    ({ duplex, staple, booklet, staplePosition, bindingSide } = mapped);
    ({ colorMode, paperSize, punch } = opts);
    // The server is the authority on what a queue printer offers: refuse (inline, not held) anything the
    // profile does not declare, instead of sending it to a queue that would silently ignore it.
    const unsupported = checkQueueCapabilities(
      { duplex, staple, booklet, punch },
      printerProfile.declared_capabilities as { duplex?: boolean; staple?: boolean; booklet?: boolean; punch?: boolean } | null,
    );
    if (unsupported) return { error: unsupported };
  }
  const held = heldReason !== null;

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

  // The page range is applied FIRST, so booklet padding, imposition, print math, policy and quota all work
  // on the pages that will actually print. The original upload is stored untouched; the subset is derived.
  // The held decision is already made above, so a held job never builds a subset PDF (planPageSubset only
  // validates and counts its range); the sender's range text is stored and re-applied on release.
  const pageRangeText = choices.pageRange.trim() === "" ? null : choices.pageRange.trim();
  const plan = planPageSubset({ pageRangeText, pageCount: preflight.pageCount, held });
  if (!plan.ok) return { error: plan.reason, fieldErrors: { pageRange: plan.reason } };
  const sourcePages = plan.sourcePages;
  let workingBytes = originalBytes;
  let subsetBytes: Uint8Array | null = null;
  if (plan.subsetPages) {
    try {
      subsetBytes = await createPageSubsetPdf(originalBytes, plan.subsetPages);
    } catch (err) {
      logger.error("page range subset failed", {
        organizationId,
        printerProfileId,
        pageRange: pageRangeText,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        error: "Those pages couldn't be pulled out of this PDF. Print the whole document, or re-export it (Print → Save as PDF) and try again.",
      };
    }
    workingBytes = subsetBytes;
  }

  let derivedBytes: Uint8Array | null = subsetBytes;
  let effectivePageCount = sourcePages;
  let blankPagesAdded = 0;

  if (held) {
    // Held jobs print nothing yet: no imposition, only the originals and an estimate. The sender (or an
    // admin) finishes it later from the stored original and page range.
    derivedBytes = null;
    if (booklet) effectivePageCount = computeBookletPadding(sourcePages).paddedPages;
  } else if (booklet) {
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
    //
    // Wrapped because these two are the only steps in this function that
    // re-write the user's PDF rather than just reading it, and pdf-lib can
    // throw on a document that nonetheless passed preflight (an unusual
    // page tree, a page with no MediaBox of its own to inherit, an
    // embedding pdf-lib can parse but not copy). Uncaught, that threw out of
    // the Server Action and rendered the error boundary - a bare "something
    // went wrong" on the booklet path specifically, with nothing recorded
    // anywhere saying which document or profile did it. Nothing has been
    // reserved or uploaded at this point, so returning is a clean stop.
    try {
      const padded = await createBookletPaddedPdf(workingBytes);
      effectivePageCount = padded.paddedPages;
      blankPagesAdded = padded.blankPagesAdded;

      // The side the member chose for this booklet (else the printer's own default, resolved above) is
      // also stored on the job, so imposition, the Agent and a re-print all agree on it.
      derivedBytes = await imposeBookletPdf(padded.bytes, resolvePaperSizePoints(paperSize), bindingSide ?? profileBindingSide);
    } catch (err) {
      logger.error("booklet imposition failed", {
        organizationId,
        printerProfileId,
        sourcePages,
        paperSize,
        bindingSide,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        error:
          "This PDF couldn't be laid out as a booklet. Try printing it without the Booklet option, or re-export it (Print → Save as PDF) and submit again.",
      };
    }
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

  // A held job is waiting for its sender's choices, so print rules, approval and quota are decided when it
  // is released (nothing is reserved now). Everything else goes through policy exactly as before.
  let policyAction: PolicyAction | null = null;
  let policyReasons: string[] = [];
  let policyBypassed = false;
  let quotaLimit: number | null = null;
  let adminExempt = false;
  let jobStatus: "held" | "denied" | "pending_approval" | "approved" = "approved";

  if (held) {
    jobStatus = "held";
  } else {
    const evaluated = await evaluateJobPolicy(supabase, {
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
    policyAction = evaluated.result.action;
    policyReasons = evaluated.result.reasons;
    quotaLimit = evaluated.quotaLimit;

    // An org_admin's own submission bypasses a deny/require_approval outcome
    // (and, below, the quota block) by default - see lib/policy/admin-bypass.ts.
    // policy.action/policy.reasons are still stored on the job exactly as
    // evaluated; policyBypassed is only the audit flag for "this outcome was
    // overridden", shown to the admin as a warning rather than hidden.
    adminExempt = isAdminExemptFromRestrictions(session.membership.role as OrgRole, evaluated.adminsBypassRestrictions);
    policyBypassed = didBypassChangeOutcome(adminExempt, evaluated.result.action);

    if (!adminExempt) {
      if (evaluated.result.action === "deny") jobStatus = "denied";
      else if (evaluated.result.action === "require_approval") jobStatus = "pending_approval";
    }
  }
  const reservesQuota = jobStatus !== "denied" && jobStatus !== "held";

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

  if (reservesQuota) {
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
      if (reservesQuota) {
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
    // Per-job choices (migrations 0028 + 0030). staple_position is non-null exactly for a stapled raw job; a
    // booklet always records which edge it is bound on, so imposition, the Agent and a re-print agree.
    staple_position: staple ? staplePosition : null,
    page_range: pageRangeText,
    booklet_binding_side: booklet ? bindingSide : null,
    held_reason: heldReason,
    booklet_padding_added: blankPagesAdded,
    estimated_printed_sides: printMath.printedSides,
    estimated_physical_sheets: printMath.physicalSheets,
    estimated_cost_cents: costCents,
    policy_action: policyAction,
    policy_reasons: policyReasons,
    policy_bypassed_for_admin: policyBypassed,
    approved_at: jobStatus === "approved" ? now.toISOString() : null,
    expires_at:
      jobStatus === "pending_approval"
        ? new Date(now.getTime() + approvalExpiryHours * 3600 * 1000).toISOString()
        : jobStatus === "held"
          ? new Date(now.getTime() + HELD_EXPIRY_HOURS * 3600 * 1000).toISOString()
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

  // A held job stops after preflight: no policy was evaluated and nothing was approved or denied (and
  // print_job_events has no event type for "held" - its status and held_reason say it).
  const events = [
    { event_type: "JOB_CREATED" as const, metadata: {} },
    { event_type: "PDF_UPLOADED" as const, metadata: { fileName: originalFileName, fileSizeBytes: preflight.fileSizeBytes } },
    { event_type: "PREFLIGHT_COMPLETED" as const, metadata: { sourcePages, blankPagesAdded } },
    ...(jobStatus === "held"
      ? []
      : [
          {
            event_type: "POLICY_EVALUATED" as const,
            metadata: { action: policyAction, reasons: policyReasons, bypassedForAdmin: policyBypassed },
          },
          {
            event_type:
              jobStatus === "denied"
                ? ("DENIED" as const)
                : jobStatus === "pending_approval"
                  ? ("APPROVAL_REQUIRED" as const)
                  : ("APPROVED" as const),
            metadata: {},
          },
        ]),
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

  return createPrintJob(supabase, session as SessionWithMembership, originalBytes, file.name, {
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

  return createPrintJob(supabase, session as SessionWithMembership, originalBytes, job.original_file_name, {
    printerProfileId: job.printer_profile_id ?? "",
    choices,
    colorMode: job.color_mode as "bw" | "color",
    paperSize: job.paper_size,
    punch: finishing.punch,
    confirmBookletPadding: true,
  });
}
