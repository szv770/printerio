import { requireSessionOrRedirect } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevicesForMember } from "@/lib/devices/devices";
import { PageHeader } from "@/components/ui";
import { DevicesView } from "./DevicesView";

export default async function DevicesPage() {
  const session = await requireSessionOrRedirect();
  if (!session.membership) return null; // the dashboard layout already redirects members without an organization
  const supabase = await createClient();
  const devices = await listDevicesForMember(supabase, { userId: session.userId, organizationId: session.membership.organization_id });

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader title="My devices" />
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Add your phone, tablet or laptop so you can print from its normal Print button. Each device gets its own private address.
      </p>
      <DevicesView
        devices={devices.map((d) => ({
          id: d.id,
          name: d.name,
          device_type: d.device_type,
          created_at: d.created_at,
          revoked_at: d.revoked_at,
          last_seen_at: d.last_seen_at,
          first_job_at: d.first_job_at,
          first_printed_at: d.first_printed_at,
        }))}
      />
    </main>
  );
}
