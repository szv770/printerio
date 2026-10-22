"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { issueRemoteCommand } from "@/lib/remote-commands";
import { isPrinterProfileIconKey } from "@/lib/printer-profile-icons";
import { createTestPrintPdf } from "@/lib/pdf/test-print";
import { preflightPdf } from "@/lib/pdf/preflight";
import { jobFilePath, PRINT_JOBS_BUCKET } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { parseOutputTarget, type OutputTarget } from "@/lib/printers/raw-target";
import { computeCostCents, computePrintMath, type PricingConfig } from "@printio/shared";
import type { TablesInsert } from "@/lib/database.types";

export interface PrinterActionState {
  error?: string;
  /** One-line confirmation for an action whose success isn't otherwise
   *  visible on the page - see components/ui's FormSuccess for why every
   *  such admin action says something rather than nothing. */
  success?: string;
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
 * Edits an existing printer's own descriptive fields. Deliberately limited to
 * the four things an admin actually types in when adding one (name, vendor,
 * model, location) - `status`/`last_status_at` are Agent-reported facts
 * (docs/architecture.md sec 11) and must never be settable by hand, or the
 * dashboard would be able to claim a printer is online when nothing has
 * reported it.
 *
 * Same defense-in-depth as createPrinterAction: org_admin only, and the
 * client-supplied printer id is only ever used together with the caller's own
 * organization_id in the WHERE clause, so a guessed id from another
 * organization matches zero rows rather than being trusted (sec 3.2). RLS is
 * still the backstop.
 */
export async function updatePrinterAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const printerId = String(formData.get("printerId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!printerId) return { error: "Missing printer." };
  if (!name) return { error: "Name is required." };

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("printers")
    .update({
      name,
      vendor: String(formData.get("vendor") ?? "").trim() || null,
      model: String(formData.get("model") ?? "").trim() || null,
      location: String(formData.get("location") ?? "").trim() || null,
    })
    .eq("id", printerId)
    .eq("organization_id", session.membership.organization_id)
    .select("id")
    .maybeSingle();
  if (error) return { error: describeDatabaseError(error, "Couldn't save that printer.") };
  if (!updated) return { error: "Printer not found in your organization." };

  revalidatePath(routes.adminPrinters);
  return { success: "Printer saved." };
}

/** The administrator-declared shape of a printer_profile, as read off either
 *  the create or the edit form. Not exported - a "use server" file may only
 *  export async functions, and this is an implementation detail of the two
 *  actions below regardless. */
interface ParsedProfileForm {
  agentId: string;
  key: string;
  label: string;
  description: string | null;
  iconKey: string | null;
  output: OutputTarget;
  declaredPaperSizes: string[];
  declaredCapabilities: { duplex: boolean; color: boolean; staple: boolean; booklet: boolean; punch: boolean };
  bookletBindingSide: "left" | "right";
  isDefault: boolean;
}

/**
 * Shared field parsing/validation for createPrinterProfileAction and
 * updatePrinterProfileAction, so the two can never drift on the key format,
 * the icon allow-list, or how an empty paper-size list is defaulted. Returns
 * either the parsed row or the exact admin-facing error to show.
 *
 * Purely a parser: it performs no authorization and no I/O. Ownership of the
 * printer and of the target agent is re-checked against the caller's own
 * organization by each action, after this returns (sec 3.2).
 */
function parsePrinterProfileForm(formData: FormData): { ok: true; value: ParsedProfileForm } | { ok: false; error: string } {
  const agentId = String(formData.get("agentId") ?? "");
  const key = String(formData.get("key") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const paperSizes = String(formData.get("paperSizes") ?? "letter")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!agentId || !key || !label) {
    return { ok: false, error: "Agent, key and label are required." };
  }
  const output = parseOutputTarget({
    outputMode: String(formData.get("outputMode") ?? "queue"),
    windowsQueueName: String(formData.get("windowsQueueName") ?? ""),
    rawHost: String(formData.get("rawHost") ?? ""),
    rawPort: String(formData.get("rawPort") ?? ""),
    rawStaplePosition: String(formData.get("rawStaplePosition") ?? ""),
  });
  if (!output.ok) return { ok: false, error: output.error };
  if (!/^[a-z0-9_]+$/.test(key)) {
    return { ok: false, error: "Key must be lowercase letters, numbers, underscores only." };
  }

  const iconKeyRaw = String(formData.get("iconKey") ?? "").trim();
  if (iconKeyRaw && !isPrinterProfileIconKey(iconKeyRaw)) {
    // Defense in depth - the DB CHECK constraint is the actual enforcement,
    // this just gives a friendlier error than a raw Postgres one. The picker
    // UI only ever submits one of the allow-listed values.
    return { ok: false, error: "Not a recognized icon." };
  }

  return {
    ok: true,
    value: {
      agentId,
      key,
      label,
      description: String(formData.get("description") ?? "").trim() || null,
      iconKey: iconKeyRaw || null,
      output: output.value,
      declaredPaperSizes: paperSizes.length > 0 ? paperSizes : ["letter"],
      declaredCapabilities: {
        duplex: formData.get("duplex") === "on",
        color: formData.get("color") === "on",
        staple: formData.get("staple") === "on",
        booklet: formData.get("booklet") === "on",
        punch: formData.get("punch") === "on",
      },
      bookletBindingSide: formData.get("bookletBindingSide") === "right" ? "right" : "left",
      isDefault: formData.get("isDefault") === "on",
    },
  };
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
  if (!printerId) return { error: "All fields except paper sizes are required." };

  const parsed = parsePrinterProfileForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const profile = parsed.value;

  const supabase = await createClient();

  // Verify the printer/agent belong to this org before inserting (defense in
  // depth - RLS also enforces this, but a clear error here is friendlier).
  const [{ data: printer }, { data: agent }] = await Promise.all([
    supabase.from("printers").select("organization_id").eq("id", printerId).maybeSingle(),
    supabase.from("agents").select("organization_id").eq("id", profile.agentId).maybeSingle(),
  ]);
  if (printer?.organization_id !== session.membership.organization_id || agent?.organization_id !== session.membership.organization_id) {
    return { error: "Printer or agent not found in your organization." };
  }

  const { error } = await supabase.from("printer_profiles").insert({
    printer_id: printerId,
    agent_id: profile.agentId,
    key: profile.key,
    label: profile.label,
    description: profile.description,
    icon_key: profile.iconKey,
    windows_queue_name: profile.output.windowsQueueName,
    output_mode: profile.output.outputMode,
    raw_host: profile.output.rawHost,
    raw_port: profile.output.rawPort,
    raw_staple_position: profile.output.rawStaplePosition,
    declared_paper_sizes: profile.declaredPaperSizes,
    declared_capabilities: profile.declaredCapabilities,
    booklet_binding_side: profile.bookletBindingSide,
    is_default: profile.isDefault,
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't save that printer profile.") };

  revalidatePath(routes.adminPrinters);
  return {};
}

/**
 * Edits an existing printer_profile in place - including the two mappings an
 * admin genuinely needs to be able to change after hardware moves: the
 * `windows_queue_name` this logical profile resolves to, and which registered
 * Agent's machine that queue lives on. Without this, a printer moving to a
 * different PC (or a queue being renamed in Windows) meant deleting and
 * re-creating the profile, which is exactly what a profile id being
 * referenced by every historical print_jobs row makes undesirable.
 *
 * Authorization is the same three-layer shape as its sibling create action:
 *   1. org_admin only (requireOrgRole).
 *   2. The profile is looked up through its OWN printer's organization_id and
 *      rejected unless that is the caller's organization - the client-supplied
 *      profile id is never trusted on its own (docs/architecture.md sec 3.2).
 *   3. The newly-chosen agent_id is independently re-checked against the
 *      caller's organization, so a tampered request cannot re-point one org's
 *      queue at another org's Agent.
 * RLS (printer_profiles' own update policy) remains the backstop under all
 * three.
 *
 * The profile stays on its current printer: moving a profile between printers
 * would silently rewrite what every historical job on it was printed on, so
 * that is deliberately not offered here.
 */
export async function updatePrinterProfileAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const organizationId = session.membership.organization_id;
  const printerProfileId = String(formData.get("printerProfileId") ?? "");
  if (!printerProfileId) return { error: "Missing printer profile." };

  const parsed = parsePrinterProfileForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const profile = parsed.value;

  const supabase = await createClient();

  const [{ data: existing }, { data: agent }] = await Promise.all([
    supabase
      .from("printer_profiles")
      .select("id, agent_id, printers!inner(id, organization_id)")
      .eq("id", printerProfileId)
      .maybeSingle(),
    supabase.from("agents").select("organization_id").eq("id", profile.agentId).maybeSingle(),
  ]);
  if (!existing || existing.printers.organization_id !== organizationId) {
    return { error: "That printer profile isn't in your organization." };
  }
  if (!agent || agent.organization_id !== organizationId) {
    return { error: "Agent not found in your organization." };
  }

  const { data: updated, error } = await supabase
    .from("printer_profiles")
    .update({
      agent_id: profile.agentId,
      key: profile.key,
      label: profile.label,
      description: profile.description,
      icon_key: profile.iconKey,
      windows_queue_name: profile.output.windowsQueueName,
      output_mode: profile.output.outputMode,
      raw_host: profile.output.rawHost,
      raw_port: profile.output.rawPort,
      raw_staple_position: profile.output.rawStaplePosition,
      declared_paper_sizes: profile.declaredPaperSizes,
      declared_capabilities: profile.declaredCapabilities,
      booklet_binding_side: profile.bookletBindingSide,
      is_default: profile.isDefault,
    })
    .eq("id", printerProfileId)
    .select("id")
    .maybeSingle();
  if (error) return { error: describeDatabaseError(error, "Couldn't save that printer profile.") };
  if (!updated) return { error: "That printer profile isn't in your organization." };

  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: session.userId,
    action: "printer_profile.updated",
    target_type: "printer_profiles",
    target_id: printerProfileId,
    // What an admin will actually want to reconstruct later is which queue
    // and which machine this logical profile pointed at, since that is what
    // silently changes where paper comes out.
    metadata: {
      outputMode: profile.output.outputMode,
      windowsQueueName: profile.output.windowsQueueName,
      rawHost: profile.output.rawHost,
      rawPort: profile.output.rawPort,
      agentId: profile.agentId,
      previousAgentId: existing.agent_id,
    },
  });

  revalidatePath(routes.adminPrinters);
  revalidatePath(routes.adminAgentDetail(profile.agentId));
  if (existing.agent_id !== profile.agentId) revalidatePath(routes.adminAgentDetail(existing.agent_id));
  return {
    success:
      profile.output.outputMode === "raw"
        ? `Saved - this profile now prints directly to ${profile.output.rawHost}:${profile.output.rawPort}.`
        : `Saved - this profile now prints to "${profile.output.windowsQueueName}".`,
  };
}

/**
 * Removes a printer_profile an admin created by mistake (or that no longer
 * exists as a Windows queue).
 *
 * `print_jobs.printer_profile_id` references this table with no ON DELETE
 * action, so a profile any job has ever used cannot be deleted - the FK
 * refuses, and that is correct: a job's audit trail must keep naming the
 * profile it was actually printed on. The count is checked here first purely
 * so the admin gets that explanation instead of a raw constraint violation,
 * and is told to edit the profile (above) rather than remove it.
 *
 * This is the delete deleteAgentAction's own error message already points
 * admins at ("reassign or delete them first (Printers page)"), which until now
 * had no UI behind it.
 */
export async function deletePrinterProfileAction(_prev: PrinterActionState, formData: FormData): Promise<PrinterActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const organizationId = session.membership.organization_id;
  const printerProfileId = String(formData.get("printerProfileId") ?? "");
  if (!printerProfileId) return { error: "Missing printer profile." };

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("printer_profiles")
    .select("id, label, agent_id, printers!inner(organization_id)")
    .eq("id", printerProfileId)
    .maybeSingle();
  if (!existing || existing.printers.organization_id !== organizationId) {
    return { error: "That printer profile isn't in your organization." };
  }

  const { count } = await supabase
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("printer_profile_id", printerProfileId);
  if (count && count > 0) {
    return {
      error: `${count} print job${count === 1 ? " has" : "s have"} been sent to this profile, so it can't be deleted without breaking their history - edit it instead to point it at a different queue.`,
    };
  }

  const { error } = await supabase.from("printer_profiles").delete().eq("id", printerProfileId);
  if (error) return { error: describeDatabaseError(error, "Couldn't delete that printer profile.") };

  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: session.userId,
    action: "printer_profile.deleted",
    target_type: "printer_profiles",
    target_id: printerProfileId,
    metadata: { label: existing.label, agentId: existing.agent_id },
  });

  revalidatePath(routes.adminPrinters);
  revalidatePath(routes.adminAgentDetail(existing.agent_id));
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
 * an admin can prove a queue works end to end without waiting for a user
 * to submit something.
 *
 * What makes it a genuine test rather than a simulation: everything after the
 * PDF is generated is the ordinary path a user's essay takes. The
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
    windowsQueueName: profile.windows_queue_name ?? (profile.raw_host ? `direct to ${profile.raw_host}:${profile.raw_port}` : "(none)"),
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

  // Writes for the job (storage object, print_jobs row, events) use the service role: members, admins included, have
  // no direct INSERT on print_jobs or the print-jobs bucket (migration 0034). Everything written is built above from
  // the session (org_admin of THIS organization, created_by = the caller) and the verified profile - the form only
  // supplied the profile id, which was checked against the caller's organization.
  const service = createServiceRoleClient();
  const originalPath = jobFilePath(organizationId, jobId, "original");
  const { error: uploadError } = await service.storage
    .from(PRINT_JOBS_BUCKET)
    .upload(originalPath, pdfBytes, { contentType: "application/pdf" });
  if (uploadError) {
    logger.error("test print storage upload failed", { jobId, organizationId, error: uploadError.message });
    return { error: "Couldn't upload the test page to storage. Nothing was sent - try again." };
  }

  const fileName = `Printio test print - ${profile.label}.pdf`;
  const { error: insertError } = await service.from("print_jobs").insert({
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
    const { error: cleanupError } = await service.storage.from(PRINT_JOBS_BUCKET).remove([originalPath]);
    if (cleanupError) {
      logger.error("failed to clean up an orphaned test print upload", { jobId, organizationId, error: cleanupError.message });
    }
    logger.error("test print job insert failed", { jobId, organizationId, error: insertError.message });
    return { error: describeDatabaseError(insertError, "Couldn't create the test print job.") };
  }

  await service.from("print_job_events").insert(
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
  // One destination for the whole batch: either direct-to-printer (raw) or a
  // per-card Windows queue chosen on each card.
  const wizardMode = formData.get("outputMode") === "raw" ? "raw" : "queue";
  const rawOutput = parseOutputTarget({
    outputMode: "raw",
    rawHost: String(formData.get("rawHost") ?? ""),
    rawPort: String(formData.get("rawPort") ?? ""),
    rawStaplePosition: String(formData.get("rawStaplePosition") ?? ""),
  });
  if (wizardMode === "raw" && !rawOutput.ok) return { error: rawOutput.error };

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
    if (!key || !label || (wizardMode === "queue" && !windowsQueueName)) {
      return { error: `Every recipe card needs a key, label, and a chosen Windows queue (missing for "${label || key || "a card"}").` };
    }
    if (!/^[a-z0-9_]+$/.test(key)) return { error: `Key "${key}" must be lowercase letters, numbers, underscores only.` };
    if (wizardMode === "queue" && discoveredQueueNames.size > 0 && !discoveredQueueNames.has(windowsQueueName)) {
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
      ...(wizardMode === "raw" && rawOutput.ok
        ? {
            windows_queue_name: null,
            output_mode: "raw",
            raw_host: rawOutput.value.rawHost,
            raw_port: rawOutput.value.rawPort,
            raw_staple_position: rawOutput.value.rawStaplePosition,
          }
        : { windows_queue_name: windowsQueueName }),
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
