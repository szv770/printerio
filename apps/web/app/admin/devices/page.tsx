import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { listDevicesForAdmin, listIssuesForDevices } from "@/lib/devices/devices";
import { sortStuckFirst, stuckReason } from "@/lib/devices/admin";
import { Plus } from "lucide-react";
import { ButtonLink, PageHeader, Tabs } from "@/components/ui";
import { routes } from "@/lib/routes";
import { printerTabs } from "@/lib/admin/tabs";
import { DevicesAdmin, type AdminDevice } from "./DevicesAdmin";
import { SetupStatusPanel } from "./SetupStatusPanel";
import { latestConnectionTests } from "@/lib/devices/connection-test-server";
import { loadSetupSummaries } from "@/lib/devices/setup-feedback-server";

export default async function AdminDevicesPage() {
  const session = await requireOrgRole(["org_admin"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const devices = await listDevicesForAdmin(supabase, { organizationId: orgId });
  const issues = await listIssuesForDevices(
    supabase,
    devices.map((d) => d.id),
  );

  const userIds = [...new Set(devices.map((d) => d.user_id))];
  const { data: profiles } =
    userIds.length > 0
      ? await supabase.from("profiles").select("id, display_name, email").in("id", userIds)
      : { data: [] as { id: string; display_name: string | null; email: string }[] };
  const names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.display_name?.trim() || p.email]));

  const openCounts: Record<string, number> = {};
  for (const i of issues) if (i.status === "open") openCounts[i.device_id] = (openCounts[i.device_id] ?? 0) + 1;

  const connection = await latestConnectionTests(supabase, devices.map((d) => d.id));
  const setups = await loadSetupSummaries(supabase, orgId).catch(() => []);

  const now = new Date();
  const sorted = sortStuckFirst(devices, openCounts, now);
  const items: AdminDevice[] = sorted.map((d) => ({
    id: d.id,
    userName: names[d.user_id] ?? "Unknown user",
    name: d.name,
    device_type: d.device_type,
    created_at: d.created_at,
    revoked_at: d.revoked_at,
    last_seen_at: d.last_seen_at,
    first_job_at: d.first_job_at,
    first_printed_at: d.first_printed_at,
    last_user_agent: d.last_user_agent,
    stuck: stuckReason(d, openCounts[d.id] ?? 0, now),
    connection: connection.get(d.id) ? { verdict: connection.get(d.id)!.verdict, createdAt: connection.get(d.id)!.createdAt } : null,
    issues: issues
      .filter((i) => i.device_id === d.id)
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        note: i.note,
        status: i.status,
        created_at: i.created_at,
        resolved_note: i.resolved_note,
        resolved_at: i.resolved_at,
      })),
  }));

  return (
    <div>
      <PageHeader
        title="All devices"
        description="Phones and laptops people print from. The ones that need a look are at the top."
        action={
          <ButtonLink href={`${routes.devices}?add=1`} size="sm" className="shrink-0">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add device
          </ButtonLink>
        }
      />
      <Tabs label="Printers and devices" items={printerTabs("devices", true)} />
      <SetupStatusPanel setups={setups} canConfirm />
      <DevicesAdmin devices={items} />
    </div>
  );
}
