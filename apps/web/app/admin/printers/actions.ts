"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { issueRemoteCommand } from "@/lib/remote-commands";
import { isPrinterProfileIconKey } from "@/lib/printer-profile-icons";
import type { TablesInsert } from "@/lib/database.types";

export interface PrinterActionState {
  error?: string;
}

const initial: PrinterActionState = {};
export { initial as initialPrinterActionState };

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
