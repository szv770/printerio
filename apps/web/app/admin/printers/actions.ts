"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { issueRemoteCommand } from "@/lib/remote-commands";
import { isPrinterProfileIconKey } from "@/lib/printer-profile-icons";
import { createTestPrintPdf } from "@/lib/pdf/test-print";
import { preflightPdf } from "@/lib/pdf/preflight";
import { jobFilePath, PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { computeCostCents, computePrintMath, type PricingConfig } from "@printio/shared";
import type { TablesInsert } from "@/lib/database.types";

export interface PrinterActionState {
  error?: string;
}


export async function createPrinterAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  const supabase = await createClient();
  const { error } = await supabase.from("printers").insert({
    organization_id: session.membership.organization_id,
    name,
    vendor: String(formData.get("vendor") ?? "") || null,
    model: String(formData.get("model") ?? "") || null,
    location: String(formData.get("location") ?? "") || null,
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't add that printer.") };

  revalidatePath(routes.adminPrinters);
  return {};
}

/**
 * Creates a logical printer_profile -> Windows queue mapping
 * (docs/architecture.md sec 9). declared_capabilities/declared_paper_sizes
 * are administrator-declared, NOT verified against the physical device - the
 * UI should make that explicit (see PrintersPanel.tsx copy).
 */
export async function createPrinterProfileAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const printerId = String(formData.get("printerId") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const key = String(formData.get("key") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const windowsQueueName = String(formData.get("windowsQueueName") ?? "").trim();
  const paperSizes = String(formData.get("paperSizes") ?? "letter")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!printerId || !agentId || !key || !label || !windowsQueueName) {
    return { error: "All fields except paper sizes are required." };
  }
  if (!/^[a-z0-9_]+$/.test(key)) return { error: "Key must be lowercase letters, numbers, underscores only." };

  const description = String(formData.get("description") ?? "").trim();
  const iconKeyRaw = String(formData.get("iconKey") ?? "").trim();
  if (iconKeyRaw && !isPrinterProfileIconKey(iconKeyRaw)) {
    // Defense in depth - the DB CHECK constraint is the actual enforcement,
    // this just gives a friendlier error than a raw Postgres one. The picker
    // UI only ever submits one of the allow-listed values.
    return { error: "Not a recognized icon." };
  }
  const bindingSide = formData.get("bookletBindingSide") === "right" ? "right" : "left";

  const supabase = await createClient();

  // Verify the printer/agent belong to this org before inserting (defense in
  // depth - RLS also enforces this, but a clear error here is friendlier).
  const [{ data: printer }, { data: agent }] = await Promise.all([
    supabase.from("printers").select("organization_id").eq("id", printerId).maybeSingle(),
    supabase.from("agents").select("organization_id").eq("id", agentId).maybeSingle(),
  ]);
  if (printer?.organization_id !== session.membership.organization_id || agent?.organization_id !== session.membership.organization_id) {
    return { error: "Printer or agent not found in your organization." };
  }

  const { error } = await supabase.from("printer_profiles").insert({
    printer_id: printerId,
    agent_id: agentId,
    key,
    label,
    description: description || null,
    icon_key: iconKeyRaw || null,
    windows_queue_name: windowsQueueName,
    declared_paper_sizes: paperSizes.length > 0 ? paperSizes : ["letter"],
    declared_capabilities: {
      duplex: formData.get("duplex") === "on",
      color: formData.get("color") === "on",
      staple: formData.get("staple") === "on",
      booklet: formData.get("booklet") === "on",
      punch: formData.get("punch") === "on",
    },
    booklet_binding_side: bindingSide,
    is_default: formData.get("isDefault") === "on",
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't save that printer profile.") };

  revalidatePath(routes.adminPrinters);
  return {};
}

/** "Refresh status" button - asks the owning Agent to re-report queue status
 *  on its next poll rather than waiting for the regular heartbeat interval.
 *  See docs/architecture.md sec 12/18. */
export async function refreshPrinterStatusAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");
  const printerId = String(formData.get("printerId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    printerId,
    command: "REFRESH_PRINTER_STATUS",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminPrinters);
  return {};
}

/** "Restart queue" button - a last-resort, whole-queue recovery action (never
 *  a routine per-job step) - see docs/architecture.md sec 11/17. */
export async function restartPrintQueueAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");
  const printerId = String(formData.get("printerId") ?? "");
  const printerProfileId = String(formData.get("printerProfileId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    printerId,
    command: "RESTART_PRINT_QUEUE",
    payload: { printerProfileId },
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminPrinters);
  return {};
}

/**
 * "Send test print" - puts a real, one-page print job through the real
 * pipeline against any printer_profile in the caller's own organization, so
 * an admin can prove a queue works end to end without waiting for a student
 * to submit something.
 *
 * What makes it a genuine test rather than a simulation: everything after the
 * PDF is generated is the ordinary path a student's essay takes. The
 * generated PDF goes through the same `preflightPdf` (docs/architecture.md
 * sec 5), is uploaded to the same private, org-scoped bucket under the same
 * `jobFilePath` convention (sec 3.3), and becomes a `print_jobs` row in
 * `approved` - which is exactly what /api/agents/jobs/claimable offers, what
 * the Agent claims and leases, what /download-url signs a URL for, and what
 * the Agent hands to SumatraPDF on the profile's Windows queue (sec 9-13).
 * No branch anywhere in the Agent, the job API, or the job state machine
 * knows or cares that this job is a test.
 *
 * What it deliberately skips is only what belongs to a *person's* job:
 *   - Policy evaluation and approval. A test print must not sit in the
 *     approval queue waiting for the very admin who sent it, and an org whose
 *     rules deny (say) all color would otherwise be unable to test its own
 *     printer. `policy_action` is left null rather than faked as "allow" -
 *     nothing evaluated, so nothing is claimed to have.
 *   - Quota. Nothing is reserved here, which is why `is_test_print` must also
 *     stop the completion/failure paths from consuming or releasing anything
 *     for this job (see app/api/agents/jobs/[jobId]/status and the cron
 *     sweep): releasing a reservation that never existed would decrement some
 *     other pending job's live reservation on the shared monthly_usage row.
 *
 * Authorization is the same defense-in-depth shape as every other action
 * here: org_admin only, and the profile id from the form is re-checked
 * against the caller's own organization through its printer's
 * organization_id before anything is generated, uploaded or written - RLS is
 * still the backstop, this is just the clear error (sec 3.2).
 */
export async function sendTestPrintAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const organizationId = session.membership.organization_id;
  const printerProfileId = String(formData.get("printerProfileId") ?? "");
  if (!printerProfileId) return { error: "Choose which printer profile to test." };

  const supabase = await createClient();

  // Same DB-backed fixed-window limiter the submit path uses (and for the
  // same reason - Vercel has no shared process to count in, see
  // supabase/migrations/0012_rate_limiting.sql). Keyed separately from
  // print_submit so a burst of test prints can't eat an admin's own
  // allowance for real submissions, or vice versa. Deliberately lower: a
  // double-clicked button should cost paper once, not ten times.
  const { data: withinLimit, error: rateLimitError } = await supabase.rpc("check_rate_limit", {
    p_key: `test_print:${session.userId}`,
    p_max_count: 10,
    p_window_seconds: 300,
  });
  if (rateLimitError) {
    logger.error("test print rate limit check failed", { userId: session.userId, error: rateLimitError.message });
  } else if (!withinLimit) {
    return { error: "You've sent a lot of test prints in the last few minutes. Wait a moment and try again." };
  }

  const [{ data: profile }, { data: organization }, { data: settings }] = await Promise.all([
    supabase
      .from("printer_profiles")
      .select("*, printers!inner(id, name, organization_id)")
      .eq("id", printerProfileId)
      .maybeSingle(),
    supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
    supabase.from("organization_settings").select("max_upload_size_bytes").eq("organization_id", organizationId).maybeSingle(),
  ]);
  // Never trust the client-supplied profile id: it only counts if its own
  // printer belongs to the caller's organization.
  if (!profile || profile.printers.organization_id !== organizationId) {
    return { error: "That printer profile isn't in your organization." };
  }

  const paperSize = profile.declared_paper_sizes[0] ?? "letter";
  const sentAt = new Date();
  const jobId = crypto.randomUUID();

  const pdfBytes = await createTestPrintPdf({
    profileLabel: profile.label,
    windowsQueueName: profile.windows_queue_name,
    printerName: profile.printers.name,
    sentBy: session.profile.display_name ?? session.email,
    organizationName: organization?.name ?? "This organization",
    jobId,
    sentAt,
    paperSize,
  });

  // The real preflight, not a rubber stamp: if this ever fails, the generator
  // above is producing something the ordinary upload path would reject too,
  // and that is worth surfacing rather than printing anyway.
  const preflight = await preflightPdf(pdfBytes, { maxSizeBytes: settings?.max_upload_size_bytes ?? 52428800 });
  if (!preflight.ok) {
    logger.error("generated test print failed preflight", { organizationId, printerProfileId, reason: preflight.reason });
    return { error: "Couldn't build a valid test page for this printer. Nothing was sent." };
  }

  // One page, one copy, black & white, single-sided, and no finishing flags
  // requested. That last part is the point rather than a limitation: what a
  // queue's driver defaults actually do (staple, fold, saddle-stitch) is
  // precisely what Printio cannot introspect (docs/architecture.md sec 9), so
  // a test print asks for nothing and lets the sheet that comes out show the
  // admin what that queue is really configured to do.
  const printMath = computePrintMath({ pageCount: preflight.pageCount, copies: 1, duplex: false, booklet: false });
  const costCents = computeCostCents({
    printedSides: printMath.printedSides,
    copies: 1,
    colorMode: "bw",
    paperSize,
    finishingStaple: false,
    finishingBooklet: false,
    pricing: (profile.pricing as unknown as PricingConfig | null) ?? null,
  });

  const originalPath = jobFilePath(organizationId, jobId, "original");
  const { error: uploadError } = await supabase.storage
    .from(PRINT_JOBS_BUCKET)
    .upload(originalPath, pdfBytes, { contentType: "application/pdf" });
  if (uploadError) {
    logger.error("test print storage upload failed", { jobId, organizationId, error: uploadError.message });
    return { error: "Couldn't upload the test page to storage. Nothing was sent - try again." };
  }

  const fileName = `Printio test print - ${profile.label}.pdf`;
  const { error: insertError } = await supabase.from("print_jobs").insert({
    id: jobId,
    organization_id: organizationId,
    created_by: session.userId,
    printer_id: profile.printers.id,
    printer_profile_id: profile.id,
    status: "approved",
    is_test_print: true,
    original_file_path: originalPath,
    derived_file_path: null,
    original_file_name: fileName,
    source_pdf_pages: preflight.pageCount,
    file_size_bytes: preflight.fileSizeBytes,
    copies: 1,
    color_mode: "bw",
    duplex: false,
    paper_size: paperSize,
    finishing: { staple: false, booklet: false, punch: false },
    estimated_printed_sides: printMath.printedSides,
    estimated_physical_sheets: printMath.physicalSheets,
    estimated_cost_cents: costCents,
    // Null, not 'allow': the policy engine was never run for this job, and
    // recording an outcome it never produced would make the audit trail lie.
    policy_action: null,
    policy_reasons: [],
    approved_at: sentAt.toISOString(),
    expires_at: null,
  });
  if (insertError) {
    // Don't leave the object orphaned in the bucket - the retention sweep
    // walks print_jobs rows, so a file with no row is never reclaimed.
    const { error: cleanupError } = await supabase.storage.from(PRINT_JOBS_BUCKET).remove([originalPath]);
    if (cleanupError) {
      logger.error("failed to clean up an orphaned test print upload", { jobId, organizationId, error: cleanupError.message });
    }
    logger.error("test print job insert failed", { jobId, organizationId, error: insertError.message });
    return { error: describeDatabaseError(insertError, "Couldn't create the test print job.") };
  }

  await supabase.from("print_job_events").insert(
    [
      {
        event_type: "JOB_CREATED" as const,
        metadata: { testPrint: true, printerProfileId: profile.id, printerProfileLabel: profile.label },
      },
      { event_type: "PDF_UPLOADED" as const, metadata: { fileName, fileSizeBytes: preflight.fileSizeBytes } },
      { event_type: "PREFLIGHT_COMPLETED" as const, metadata: { sourcePages: preflight.pageCount, blankPagesAdded: 0 } },
      {
        event_type: "APPROVED" as const,
        metadata: {
          testPrint: true,
          reason: "Admin test print - print rules, approval and quota are deliberately skipped for a test print.",
        },
      },
    ].map((event) => ({
      job_id: jobId,
      event_type: event.event_type,
      actor_type: "admin" as const,
      actor_id: session.userId,
      metadata: event.metadata,
    })),
  );

  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: session.userId,
    action: "printer_profile.test_print_sent",
    target_type: "printer_profiles",
    target_id: profile.id,
    metadata: { jobId, printerId: profile.printers.id, agentId: profile.agent_id },
  });

  revalidatePath(routes.adminPrinters);
  revalidatePath(routes.adminAgentDetail(profile.agent_id));
  // Straight to the same job page a real submission lands on - the admin
  // watches this test move through the identical stepper, because it is
  // moving through the identical pipeline.
  redirect(routes.job(jobId));
}

/** One recipe card submitted from the guided setup wizard's Step 3
 *  (app/admin/printers/setup) - the client-side shape of
 *  lib/printer-setup-wizard.ts's `RecipeCard`, plus the real Windows queue
 *  name the admin picked for it from that Agent's discovered_queues. */
interface WizardRecipeCardInput {
  key: string;
  label: string;
  description: string;
  iconKey: string;
  declaredCapabilities: { duplex: boolean; color: boolean; staple: boolean; booklet: boolean; punch: boolean };
  bookletBindingSide: "left" | "right";
  windowsQueueName: string;
}

/**
 * Finishes the guided setup wizard (app/admin/printers/setup, Step 3):
 * creates one printer_profiles row per recipe card in a single batch insert,
 * all targeting the same printer + agent chosen in that step. Thin wrapper
 * around the exact same validation/authorization/insert shape
 * `createPrinterProfileAction` already uses above - duplicated rather than
 * looped-called because a single multi-row insert is one atomic statement
 * (all cards succeed or none do, e.g. on a duplicate `key` collision),
 * where N separate single-row calls would not be.
 *
 * Never trusts the client-supplied organization_id - both printerId and
 * agentId are re-checked against the caller's own org before anything is
 * written (same defense-in-depth as createPrinterProfileAction).
 */
export async function createPrinterProfilesFromWizardAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const orgId = session.membership.organization_id;

  const printerId = String(formData.get("printerId") ?? "");
  const newPrinterName = String(formData.get("newPrinterName") ?? "").trim();
  const agentId = String(formData.get("agentId") ?? "");
  const cardsRaw = String(formData.get("cardsJson") ?? "");

  if (!agentId) return { error: "Choose which Agent's machine these queues live on." };
  if (!printerId && !newPrinterName) return { error: "Choose a printer, or name the new one." };

  let cards: WizardRecipeCardInput[];
  try {
    cards = JSON.parse(cardsRaw);
    if (!Array.isArray(cards) || cards.length === 0) throw new Error("empty");
  } catch {
    return { error: "No recipe cards to save - go back to Step 1 and pick at least one profile type." };
  }

  const supabase = await createClient();

  const { data: agent } = await supabase.from("agents").select("organization_id, discovered_queues").eq("id", agentId).maybeSingle();
  if (!agent || agent.organization_id !== orgId) return { error: "Agent not found in your organization." };

  const discoveredQueueNames = new Set(
    (Array.isArray(agent.discovered_queues) ? agent.discovered_queues : [])
      .map((q) => (q && typeof q === "object" && "windowsQueueName" in q ? String((q as { windowsQueueName?: unknown }).windowsQueueName) : null))
      .filter((n): n is string => !!n),
  );

  // Every card is validated BEFORE any row is written. This used to run after
  // the "create a new printer" branch below, so a single bad card (or a
  // duplicate `key` colliding on insert) left a freshly-created, empty
  // `printers` row behind - and each retry of the wizard added another one for
  // the admin to clean up by hand.
  const validated: Omit<TablesInsert<"printer_profiles">, "printer_id">[] = [];
  for (const card of cards) {
    const key = String(card.key ?? "").trim();
    const label = String(card.label ?? "").trim();
    const windowsQueueName = String(card.windowsQueueName ?? "").trim();
    if (!key || !label || !windowsQueueName) {
      return { error: `Every recipe card needs a key, label, and a chosen Windows queue (missing for "${label || key || "a card"}").` };
    }
    if (!/^[a-z0-9_]+$/.test(key)) return { error: `Key "${key}" must be lowercase letters, numbers, underscores only.` };
    if (discoveredQueueNames.size > 0 && !discoveredQueueNames.has(windowsQueueName)) {
      // Defense in depth - the Step 3 <select> only ever offers queues this
      // Agent actually reported, so this only fires against a tampered
      // request. If the Agent has reported nothing at all yet,
      // discoveredQueueNames is empty and this check is skipped rather than
      // blocking every submission - Step 3's own UI is what stops that case
      // (docs/printer-setup.md link + "no queues discovered yet" messaging),
      // not this server-side guard.
      return { error: `"${windowsQueueName}" isn't a queue this Agent has reported - refresh Step 3 and pick again.` };
    }
    const iconKeyRaw = String(card.iconKey ?? "").trim();
    if (iconKeyRaw && !isPrinterProfileIconKey(iconKeyRaw)) return { error: "Not a recognized icon." };
    const bindingSide = card.bookletBindingSide === "right" ? "right" : "left";

    validated.push({
      agent_id: agentId,
      key,
      label,
      description: String(card.description ?? "").trim() || null,
      icon_key: iconKeyRaw || null,
      windows_queue_name: windowsQueueName,
      declared_paper_sizes: ["letter"],
      declared_capabilities: {
        duplex: !!card.declaredCapabilities?.duplex,
        color: !!card.declaredCapabilities?.color,
        staple: !!card.declaredCapabilities?.staple,
        booklet: !!card.declaredCapabilities?.booklet,
        punch: !!card.declaredCapabilities?.punch,
      },
      booklet_binding_side: bindingSide,
      is_default: false,
    });
  }

  // Two cards claiming the same key would violate printer_profiles' own
  // unique (printer_id, key) - caught here so the message names the key
  // instead of surfacing a constraint name, and before a printer is created.
  const duplicateKey = validated.map((r) => r.key).find((k, i, all) => all.indexOf(k) !== i);
  if (duplicateKey) {
    return { error: `Two recipe cards both use the key "${duplicateKey}" - each profile on a printer needs its own key.` };
  }

  let resolvedPrinterId = printerId;
  let createdPrinterId: string | null = null;
  if (!resolvedPrinterId) {
    if (!newPrinterName) return { error: "Name is required for a new printer." };
    const { data: newPrinter, error: printerError } = await supabase
      .from("printers")
      .insert({ organization_id: orgId, name: newPrinterName })
      .select("id")
      .single();
    if (printerError || !newPrinter) {
      return { error: describeDatabaseError(printerError, "Couldn't create that printer.") };
    }
    resolvedPrinterId = newPrinter.id;
    createdPrinterId = newPrinter.id;
  } else {
    const { data: printer } = await supabase.from("printers").select("organization_id").eq("id", resolvedPrinterId).maybeSingle();
    if (printer?.organization_id !== orgId) return { error: "Printer not found in your organization." };
  }

  const { error } = await supabase
    .from("printer_profiles")
    .insert(validated.map((row) => ({ ...row, printer_id: resolvedPrinterId })));
  if (error) {
    // Undo the printer this call just created, so a failed wizard run doesn't
    // leave an empty printer behind for the admin to notice and delete.
    if (createdPrinterId) {
      await supabase.from("printers").delete().eq("id", createdPrinterId).eq("organization_id", orgId);
    }
    return { error: describeDatabaseError(error, "Couldn't save these printer profiles.") };
  }

  revalidatePath(routes.adminPrinters);
  revalidatePath(routes.adminPrintersSetup);
  redirect(routes.adminPrinters);
}
