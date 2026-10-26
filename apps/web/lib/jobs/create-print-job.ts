import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { preflightPdf } from "@/lib/pdf/preflight";
import { bookletSheetChoice, padAndImposeBooklet, type BookletSheet } from "@/lib/pdf/booklet-build";
import type { BookletFit } from "@/lib/pdf/imposition";
import { containsPjlEscape, PJL_ESCAPE_MESSAGE, computePrintMath, computeCostCents, computeBookletPadding, type PolicyAction, type PricingConfig, type OrgRole } from "@printio/shared";
import { createPageSubsetPdf } from "@/lib/pdf/page-subset";
import { stampFirstPage } from "@/lib/pdf/stamp";
import { buildStampText, normalizeStampSettings } from "@/lib/jobs/user-code";
import { ensureMemberUserCode } from "@/lib/jobs/ensure-user-code";
import { checkQueueCapabilities, mapQueueChoices, mapRawChoices, planPageSubset, type BindingSide, type PrintChoices } from "@/lib/print-choices";
import { evaluateJobPolicy } from "@/lib/policy/build-facts";
import { approverSkipsApproval, didBypassChangeOutcome, isAdminExemptFromRestrictions } from "@/lib/policy/admin-bypass";
import { adjustMonthlyUsage, usageAmountsForJob, type UsageAmounts } from "@/lib/quota";
import { jobFilePath, PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";

/** A held job waits for its sender (or an admin) for this long before it is cancelled with a note. */
const HELD_EXPIRY_HOURS = 7 * 24;

/**
 * The part of a session the pipeline needs. The website passes its SessionWithMembership (structurally
 * compatible); the IPP gateway routes build one from the device's member row. The Supabase client passed
 * alongside may be the member's own (website) or the service role acting for them (gateway): nothing here
 * reads auth.uid(), and every org check below is explicit, so both behave the same.
 */
export interface JobSession {
  userId: string;
  membership: { organization_id: string; role: string; department: string | null };
}

export interface JobOptions {
  printerProfileId: string;
  /** The upload page's plain choices (sides / staple / booklet / copies / page range). */
  choices: PrintChoices;
  /** Queue-mode printers only: raw printers hide these controls, and the server derives them itself. */
  colorMode: "bw" | "color";
  paperSize: string;
  punch: boolean;
  confirmBookletPadding: boolean;
  /** Booklet jobs only. "fill" (default; also what IPP / gateway jobs get) crops the document's own blank margins so the content fills the page; "keep" scales the whole page as before. Stored in print_jobs.finishing. */
  bookletFit?: BookletFit;
  /** Booklet jobs only. "tabloid" = Letter pages at full size on an 11x17 sheet (whole page kept, no crop); default "letter" = regular statement-size pages. Stored in print_jobs.finishing; the row's paper_size becomes tabloid. */
  bookletSheet?: BookletSheet;
  /** Create the job as held with this plain-language reason (wins over the printer's own held reason). */
  forcedHeldReason?: string;
  /** Where the job came from. Default "web". */
  source?: "web" | "ipp";
  /** member_devices.id, for source "ipp". */
  deviceId?: string;
  ippUserAgent?: string;
  /** Client for every write (quota, storage, print_jobs, events). The website passes the service-role client; defaults to the main client (the gateway already is service-role). */
  writeClient?: SupabaseClient<Database>;
}

export type CreatePrintJobErrorCode =
  | "invalid_request"
  | "rate_limited"
  | "printer_unavailable"
  | "unsupported_option"
  | "too_large"
  | "bad_pdf"
  | "invalid_page_range"
  | "subset_failed"
  | "booklet_failed"
  | "quota_exceeded"
  | "storage_failed"
  | "insert_failed";

export type CreatePrintJobResult =
  | {
      ok: true;
      jobId: string;
      jobNumber: string;
      status: "held" | "denied" | "pending_approval" | "approved";
      heldReason: string | null;
      /** The policy engine's reasons (empty for a held job, which is not evaluated yet). */
      policyReasons: string[];
    }
  | {
      ok: false;
      kind: "error";
      error: string;
      code: CreatePrintJobErrorCode;
      /** Errors that belong next to one field of the form (the page range today). */
      fieldErrors?: { pageRange?: string };
    }
  | {
      ok: false;
      kind: "needs_booklet_confirm";
      needsBookletConfirm: { sourcePages: number; paddedPages: number; blankPagesAdded: number };
    };

function fail(error: string, code: CreatePrintJobErrorCode, fieldErrors?: { pageRange?: string }): CreatePrintJobResult {
  return { ok: false, kind: "error", error, code, ...(fieldErrors ? { fieldErrors } : {}) };
}

/**
 * The actual job-creation pipeline - preflight, booklet imposition, print
 * math, policy evaluation, quota reservation, storage upload, the
 * print_jobs insert, and its event trail. Shared by the website's server
 * actions (a fresh upload, and "print again") and the IPP gateway routes, so
 * this logic - the actual money path - exists exactly once. It RETURNS a
 * result and never redirects or throws Next-only control flow; the callers
 * decide what success looks like.
 */
export async function createPrintJob(
  supabase: SupabaseClient<Database>,
  session: JobSession,
  originalBytes: Uint8Array,
  originalFileName: string,
  opts: JobOptions,
): Promise<CreatePrintJobResult> {
  const organizationId = session.membership.organization_id;
  const { printerProfileId, choices, confirmBookletPadding } = opts;
  const source = opts.source ?? "web";
  const bookletFit: BookletFit = opts.bookletFit === "keep" ? "keep" : "fill";
  const bookletSheet: BookletSheet = bookletSheetChoice(opts.bookletSheet);
  // Reads go through `supabase`; every WRITE (quota reserve/release, storage upload/remove, the print_jobs insert,
  // the event trail) goes through `writer`. The website passes the service-role client here after its own session
  // checks, so members need no INSERT/UPDATE rights on print_jobs, monthly_usage or the print-jobs bucket
  // (migration 0034). organization_id and created_by below always come from `session`, never from `opts`.
  const writer = opts.writeClient ?? supabase;

  if (!printerProfileId) return fail("Choose a printer.", "invalid_request");

  // Fixed-window rate limit, checked before any expensive work (PDF parsing,
  // storage upload) - see supabase/migrations/0012_rate_limiting.sql for why
  // this has to be DB-backed rather than in-memory on Vercel. Scoped per
  // user, not per org, so one runaway script/loop can't starve the rest of
  // the organization's submit capacity either.
  // Called through `writer` (the service-role client): migration 0037 takes EXECUTE on check_rate_limit away from
  // signed-in members, who could otherwise burn another person's allowance. The session was authorized by the caller.
  const { data: withinLimit, error: rateLimitError } = await writer.rpc("check_rate_limit", {
    p_key: `print_submit:${session.userId}`,
    p_max_count: 20,
    p_window_seconds: 300,
  });
  if (rateLimitError) {
    logger.error("rate limit check failed", { userId: session.userId, error: rateLimitError.message });
  } else if (!withinLimit) {
    return fail("You're submitting jobs too quickly. Wait a few minutes and try again.", "rate_limited");
  }

  // Independent lookups - the profile doesn't gate the settings read or vice
  // versa - so they overlap instead of costing two sequential round trips
  // while the user waits with their file already uploaded.
  const [{ data: printerProfile, error: profileError }, { data: settings }, { data: memberRow }] = await Promise.all([
    supabase.from("printer_profiles").select("*, printers!inner(id, organization_id)").eq("id", printerProfileId).single(),
    supabase.from("organization_settings").select("*").eq("organization_id", organizationId).single(),
    // The sender's user code (and the name/email its fallback is built from) for the page-1 stamp. A failed or
    // empty read is not an error: the code is then generated and saved (ensureMemberUserCode) instead of failing the job.
    supabase
      .from("organization_members")
      .select("user_code, profiles(display_name, email)")
      .eq("user_id", session.userId)
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);
  if (profileError || !printerProfile || printerProfile.printers.organization_id !== organizationId) {
    return fail("Selected printer is not available.", "printer_unavailable");
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
  let duplexEdge: "short" | null = null;
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
    duplexEdge = mapped.duplexEdge;
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
    if (unsupported) return fail(unsupported, "unsupported_option");
    // A Windows queue cannot be told which edge to flip on from here: hold it with a plain reason, never print it the wrong way.
    if (choices.flip === "short" && duplex && !booklet) heldReason = "This printer is not set up to flip on the short edge, so nothing was printed. Choose double-sided (long edge).";
  }
  // The caller can force a hold with its own plain-language reason (the IPP gateway does this for anything the
  // print dialog asked for that the website pipeline cannot honour). It wins over the printer's own reason.
  if (opts.forcedHeldReason) heldReason = opts.forcedHeldReason;
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
    return fail(`File exceeds this organization's ${maxMb} MB upload limit.`, "too_large");
  }

  const preflight = await preflightPdf(originalBytes, { maxSizeBytes: maxUploadBytes });
  if (!preflight.ok) return fail(preflight.reason, "bad_pdf");

  // Attachments, JavaScript and launch actions are stripped rather than refused (a teacher cannot fix them, and
  // the Android print service adds one). The upload is still stored untouched as the original; everything that
  // prints is built from the sanitized copy, so a sanitized job always gets a derived file (the Agent prints the
  // derived file whenever there is one).
  const sanitized = preflight.sanitizedBytes ?? null;
  const sourceBytes = sanitized ?? originalBytes;

  // The page range is applied FIRST, so booklet padding, imposition, print math, policy and quota all work
  // on the pages that will actually print. The original upload is stored untouched; the subset is derived.
  // The held decision is already made above, so a held job never builds a subset PDF (planPageSubset only
  // validates and counts its range); the sender's range text is stored and re-applied on release.
  let pageRangeText = choices.pageRange.trim() === "" ? null : choices.pageRange.trim();
  let plan = planPageSubset({ pageRangeText, pageCount: preflight.pageCount, held });
  if (!plan.ok && opts.forcedHeldReason) {
    // A forced hold must never fail on a range that does not fit this document (the print dialog cannot show
    // an inline error): keep the job, hold it with both reasons, and drop the range so it can be re-chosen.
    heldReason = `${opts.forcedHeldReason} ${plan.reason}`;
    pageRangeText = null;
    plan = planPageSubset({ pageRangeText, pageCount: preflight.pageCount, held });
  }
  if (!plan.ok) return fail(plan.reason, "invalid_page_range", { pageRange: plan.reason });
  const sourcePages = plan.sourcePages;
  let workingBytes = sourceBytes;
  let subsetBytes: Uint8Array | null = null;
  if (plan.subsetPages) {
    try {
      subsetBytes = await createPageSubsetPdf(sourceBytes, plan.subsetPages);
    } catch (err) {
      logger.error("page range subset failed", {
        organizationId,
        printerProfileId,
        pageRange: pageRangeText,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(
        "Those pages couldn't be pulled out of this PDF. Print the whole document, or re-export it (Print → Save as PDF) and try again.",
        "subset_failed",
      );
    }
    workingBytes = subsetBytes;
  }

  let derivedBytes: Uint8Array | null = subsetBytes ?? sanitized;
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
        ok: false,
        kind: "needs_booklet_confirm",
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
      const built = await padAndImposeBooklet(workingBytes, {
        paperSize,
        // The side the member chose for this booklet (else the printer's own default, resolved above) is also stored
        // on the job, so imposition, the Agent and a re-print all agree on it.
        bindingSide: bindingSide ?? profileBindingSide,
        fit: bookletFit,
        sheet: bookletSheet,
      });
      effectivePageCount = built.paddedPages;
      blankPagesAdded = built.blankPagesAdded;
      derivedBytes = built.bytes;
    } catch (err) {
      logger.error("booklet imposition failed", {
        organizationId,
        printerProfileId,
        sourcePages,
        paperSize,
        bindingSide,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(
        "This PDF couldn't be laid out as a booklet. Try printing it without the Booklet option, or re-export it (Print → Save as PDF) and submit again.",
        "booklet_failed",
      );
    }
  }

  // The user code stamp (docs/superpowers/specs/2026-10-20-printio-setup-design.md, Phase 3). Applied LAST, to the
  // final file that will print (after page range, padding and booklet imposition), so it lands on page 1 of the
  // first sheet side - the booklet's cover sheet included - and it is the same for website and IPP jobs. Copies
  // are made by the printer from this one file, so every copy carries it. A held job prints nothing yet and is
  // stamped when it is released (that re-runs this pipeline). The stored original is never stamped. If stamping
  // fails the job still goes through unstamped: losing a print is worse than losing a label.
  const stamp = normalizeStampSettings(settings as Record<string, unknown> | null);
  if (stamp.enabled && !held) {
    try {
      const profile = (memberRow as { user_code?: string | null; profiles?: { display_name?: string | null; email?: string | null } | null } | null) ?? null;
      // The member's PERSISTENT, org-unique code: the stored one, or (first stamp ever) a freshly generated one that is
      // saved with the write client (service role; the sender is already authorized above). If it cannot be saved the
      // stamp is skipped (caught below) rather than printing a code that is not reserved for this person.
      const code = await ensureMemberUserCode(writer, {
        organizationId,
        userId: session.userId,
        displayName: profile?.profiles?.display_name ?? null,
        email: profile?.profiles?.email ?? null,
        stored: profile?.user_code ?? null,
      });
      derivedBytes = await stampFirstPage(derivedBytes ?? sourceBytes, {
        text: buildStampText({ code, show: stamp.show, now: new Date() }),
        strength: stamp.strength,
      });
    } catch (err) {
      logger.error("user code stamp failed; printing without it", {
        organizationId,
        userId: session.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Last line of defence (security review F1): nothing that would be streamed to a printer may carry its escape
  // sequences, whichever step produced it.
  if (derivedBytes && containsPjlEscape(derivedBytes)) return fail(PJL_ESCAPE_MESSAGE, "bad_pdf");

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

    // An approver's own job skips the approval step (and only that step). Flagged like the admin bypass so it is disclosed.
    const approverAuto = approverSkipsApproval(session.membership.role as OrgRole, evaluated.result.action);
    if (approverAuto) policyBypassed = true;

    if (!adminExempt && !approverAuto) {
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
      writer,
      { organizationId, userId: session.userId },
      reservedAmounts,
      quotaBasis,
      adminExempt ? null : quotaLimit,
      "reserve",
    );

    if (!reserved) {
      return fail("This job would exceed your monthly print quota. Contact your administrator.", "quota_exceeded");
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
      if (uploadedPaths.length > 0) await writer.storage.from(PRINT_JOBS_BUCKET).remove(uploadedPaths);
      if (reservesQuota) {
        await adjustMonthlyUsage(
          writer,
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
    writer.storage.from(PRINT_JOBS_BUCKET).upload(originalPath, originalBytes, { contentType: "application/pdf" }),
    derivedBytes && derivedPath
      ? writer.storage.from(PRINT_JOBS_BUCKET).upload(derivedPath, derivedBytes, { contentType: "application/pdf" })
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
    return fail("Could not upload your document. Check your connection and submit again.", "storage_failed");
  }

  const now = new Date();
  const { data: inserted, error: insertError } = await writer
    .from("print_jobs")
    .insert({
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
    paper_size: booklet && bookletSheet === "tabloid" ? "tabloid" : paperSize,
    finishing: {
      staple,
      booklet,
      punch,
      ...(booklet ? { bookletFit, ...(bookletSheet === "tabloid" ? { bookletSheet } : {}) } : {}),
      ...(duplexEdge ? { duplexEdge } : {}),
    },
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
      // IPP jobs record where they came from. Web jobs omit these columns (they default to 'web' / null), so the
      // website's insert is unchanged.
      ...(source === "ipp" ? { source: "ipp", device_id: opts.deviceId ?? null, ipp_user_agent: opts.ippUserAgent ?? null } : {}),
    })
    .select("job_number")
    .single();
  if (insertError) {
    // Never surface a raw Postgres error to a student/staff user (column
    // names, constraint details) - log server-side only and return a
    // generic message. See docs/architecture.md sec 3.2.
    logger.error("print_jobs insert failed", { jobId, organizationId, error: insertError.message });
    await rollback([originalPath, ...(derivedPath ? [derivedPath] : [])]);
    return fail("Could not create the print job. Your file is still selected - submit again.", "insert_failed");
  }

  // A held job stops after preflight: no policy was evaluated and nothing was approved or denied (and
  // print_job_events has no event type for "held" - its status and held_reason say it).
  const events = [
    {
      event_type: "JOB_CREATED" as const,
      metadata: source === "ipp" ? { source: "ipp", deviceId: opts.deviceId ?? null } : {},
    },
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
  await writer.from("print_job_events").insert(
    events.map((e) => ({
      job_id: jobId,
      event_type: e.event_type,
      actor_type: "user" as const,
      actor_id: session.userId,
      metadata: e.metadata,
    })),
  );

  return { ok: true, jobId, jobNumber: inserted?.job_number ?? "", status: jobStatus, heldReason, policyReasons };
}

