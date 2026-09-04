"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";

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
  if (error) return { error: error.message };

  revalidatePath("/admin/printers");
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
    windows_queue_name: windowsQueueName,
    declared_paper_sizes: paperSizes.length > 0 ? paperSizes : ["letter"],
    declared_capabilities: {
      duplex: formData.get("duplex") === "on",
      color: formData.get("color") === "on",
      staple: formData.get("staple") === "on",
      booklet: formData.get("booklet") === "on",
      punch: formData.get("punch") === "on",
    },
    is_default: formData.get("isDefault") === "on",
  });
  if (error) return { error: error.message };

  revalidatePath("/admin/printers");
  return {};
}
