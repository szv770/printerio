import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { SetupWizard, type WizardAgent, type WizardPrinter } from "./SetupWizard";

/**
 * Guided setup wizard (docs' "first-time full setup" path) - an additive,
 * more guided alternative to PrintersPanel.tsx's existing single-profile
 * NewProfileForm, not a replacement for it. Only org_admin can reach this:
 * it exists to *create* printer_profiles rows, same requirement as
 * createPrinterProfileAction/createPrinterProfilesFromWizardAction in
 * ../actions.ts (an approver can still view/manage day-to-day printers from
 * /admin/printers itself, but has no reason to be here).
 */
export default async function PrinterSetupWizardPage() {
  const session = await requireOrgRole(["org_admin"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: printers }, { data: agents }, { data: existingProfiles }, { data: settings }] = await Promise.all([
    supabase.from("printers").select("id, name").eq("organization_id", orgId).order("created_at", { ascending: true }),
    supabase
      .from("agents")
      .select("id, name, status, last_seen_at, discovered_queues")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true }),
    supabase.from("printer_profiles").select("windows_queue_name, label, printers!inner(organization_id)").eq("printers.organization_id", orgId),
    supabase.from("organization_settings").select("default_booklet_binding_side").eq("organization_id", orgId).single(),
  ]);

  const claimedQueues: Record<string, string> = {};
  for (const p of existingProfiles ?? []) {
    if (!(p.windows_queue_name in claimedQueues)) claimedQueues[p.windows_queue_name] = p.label;
  }

  const wizardAgents: WizardAgent[] = (agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    lastSeenAt: a.last_seen_at,
    discoveredQueues: Array.isArray(a.discovered_queues)
      ? (a.discovered_queues as unknown[])
          .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
          .map((q) => ({
            windowsQueueName: String(q.windowsQueueName ?? ""),
            driverName: typeof q.driverName === "string" ? q.driverName : undefined,
            portName: typeof q.portName === "string" ? q.portName : undefined,
            status: typeof q.status === "string" ? q.status : undefined,
          }))
          .filter((q) => q.windowsQueueName)
      : [],
  }));

  const wizardPrinters: WizardPrinter[] = (printers ?? []).map((p) => ({ id: p.id, name: p.name }));

  return (
    <div>
      <PageHeader
        title="Guided printer setup"
        description="Plan a set of finishing profiles, confirm the Agent machine is online, then map each profile to a real Windows queue - all in one pass."
      />
      <SetupWizard
        printers={wizardPrinters}
        agents={wizardAgents}
        claimedQueues={claimedQueues}
        defaultBookletBindingSide={settings?.default_booklet_binding_side === "right" ? "right" : "left"}
      />
    </div>
  );
}
