import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevicesForMember, listIssuesForDevices } from "@/lib/devices/devices";
import { PageHeader } from "@/components/ui";
import { DevicesView } from "./DevicesView";
import { ConfirmedBanner } from "@/components/devices/ConfirmedBanner";
import { SetupFeedbackCard } from "@/components/devices/SetupFeedbackCard";
import { listFeedbackCardDevices } from "@/lib/devices/setup-feedback-server";

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const { add } = await searchParams;
  const session = await requireSessionOrRedirect();
  if (!session.membership) return null; // the dashboard layout already redirects members without an organization
  const supabase = await createClient();
  const devices = await listDevicesForMember(supabase, { userId: session.userId, organizationId: session.membership.organization_id });

  const issues = await listIssuesForDevices(supabase, devices.map((d) => d.id));
  const openByDevice = new Map<string, number>();
  for (const i of issues) if (i.status === "open") openByDevice.set(i.device_id, (openByDevice.get(i.device_id) ?? 0) + 1);

  const feedbackDevices = await listFeedbackCardDevices(supabase, { userId: session.userId, organizationId: session.membership.organization_id });

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader
        title="My devices"
        description="Add your phone, tablet or laptop to print from its normal Print button. Each device gets its own private address."
      />
      <ConfirmedBanner />
      <SetupFeedbackCard devices={feedbackDevices} />
      <DevicesView
        startAdding={add === "1"}
        devices={devices.map((d) => ({
          id: d.id,
          name: d.name,
          device_type: d.device_type,
          created_at: d.created_at,
          revoked_at: d.revoked_at,
          last_seen_at: d.last_seen_at,
          first_job_at: d.first_job_at,
          first_printed_at: d.first_printed_at,
          open_issues: openByDevice.get(d.id) ?? 0,
        }))}
      />
    </main>
  );
}
