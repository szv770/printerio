import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { printerTabs } from "@/lib/admin/tabs";
import { PrintersPanel } from "./PrintersPanel";

export default async function PrintersPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const [{ data: printers }, { data: profiles }, { data: agents }, { data: settings }] = await Promise.all([
    supabase
      .from("printers")
      .select("id, name, vendor, model, location, status, status_detail, status_code, last_status_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("printer_profiles")
      .select(
        "id, agent_id, printer_id, key, label, description, icon_key, is_default, declared_capabilities, declared_paper_sizes, windows_queue_name, output_mode, raw_host, raw_port, raw_staple_position, booklet_binding_side, printers!inner(organization_id)",
      )
      .eq("printers.organization_id", orgId)
      .limit(500),
    supabase.from("agents").select("id, name, last_seen_at, paused").eq("organization_id", orgId).limit(200),
    supabase.from("organization_settings").select("default_booklet_binding_side").eq("organization_id", orgId).single(),
  ]);

  const isOrgAdmin = session.membership.role === "org_admin";

  return (
    <div>
      <PageHeader title="Printers" description="Your printers and the print queues people can send jobs to." />
      <Tabs label="Printers and devices" items={printerTabs("printers", isOrgAdmin)} />
      <PrintersPanel
        printers={printers ?? []}
        profiles={(profiles ?? []).map(({ printers: _p, ...rest }) => rest)}
        agents={agents ?? []}
        canManage={isOrgAdmin}
        defaultBookletBindingSide={settings?.default_booklet_binding_side === "right" ? "right" : "left"}
      />
    </div>
  );
}
