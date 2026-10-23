import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, ButtonLink } from "@/components/ui";
import { routes } from "@/lib/routes";
import { isSetupComplete, setupChecklist } from "@/lib/admin-setup-checklist";
import { stuckReason } from "@/lib/devices/admin";
import { isStale } from "@/lib/home/format";
import { buildAttentionItems, buildRightNow } from "@/lib/home/admin-home";
import { firstName, jobMetaLine } from "@/lib/home/teacher-home";
import { AutoRefresh } from "@/components/home/AutoRefresh";
import { BigPrintCard } from "@/components/home/BigPrintCard";
import { NeedsAttention } from "@/components/home/NeedsAttention";
import { RightNow } from "@/components/home/RightNow";
import { RecentJobs } from "@/components/home/RecentJobs";
import { SetupCard } from "@/components/home/SetupCard";

const RECENT_LIMIT = 8;
const ACTIVE_LIMIT = 8;
const LIST_CAP = 50;
const DEVICE_CAP = 200;

// Jobs that are with the print server or printing right now.
const IN_PRINTER_STATES = ["claimed", "downloading", "downloaded", "printing", "submitted_to_spooler"];

/**
 * Admin home: what needs the admin, what is happening right now, a big Print
 * button, and the latest jobs. Everything is read with the member (session)
 * client: admins/approvers can read their organization's rows under RLS, and
 * every query is filtered by organization and capped. Auto-refreshes every
 * ~15 s while the tab is visible.
 */
export default async function AdminOverviewPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  const isOrgAdmin = session.membership.role === "org_admin";
  // A fresh snapshot per request, not a value React keeps stable across renders.
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();

  const [pending, failed, held, waiting, active, recent, agentsRes, printersRes, devicesRes, membersRes, policiesRes, quotasRes] =
    await Promise.all([
      supabase
        .from("print_jobs")
        .select("created_at", { count: "exact" })
        .eq("organization_id", orgId)
        .eq("status", "pending_approval")
        .order("created_at", { ascending: true })
        .limit(1),
      supabase
        .from("print_jobs")
        .select("original_file_name, error_message", { count: "exact" })
        .eq("organization_id", orgId)
        .eq("status", "failed")
        .gte("updated_at", weekAgo)
        .order("updated_at", { ascending: false })
        .limit(3),
      supabase.from("print_jobs").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "held"),
      // Queued jobs the printer could not take yet (marker in error_message, see lib/job-waiting.ts): shown as
      // "waiting for the printer", never counted as failed.
      supabase
        .from("print_jobs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "approved")
        .like("error_message", "[printio:waiting%"),
      supabase
        .from("print_jobs")
        .select("id, job_number, printer_id, status, source_pdf_pages, copies")
        .eq("organization_id", orgId)
        .in("status", IN_PRINTER_STATES)
        .order("created_at", { ascending: false })
        .limit(ACTIVE_LIMIT),
      supabase
        .from("print_jobs")
        .select("id, original_file_name, status, error_message, created_at, source_pdf_pages, copies")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
      supabase.from("agents").select("id, name, last_seen_at").eq("organization_id", orgId).order("name").limit(LIST_CAP),
      supabase.from("printers").select("id, name, status").eq("organization_id", orgId).order("name").limit(LIST_CAP),
      // Devices and setup counts are org-admin pages/data; approvers skip them.
      isOrgAdmin
        ? supabase
            .from("member_devices")
            .select("id, revoked_at, first_seen_at, last_seen_at, first_job_at, first_printed_at, created_at")
            .eq("organization_id", orgId)
            .is("revoked_at", null)
            .order("created_at", { ascending: false })
            .limit(DEVICE_CAP)
        : Promise.resolve(null),
      isOrgAdmin
        ? supabase.from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", orgId)
        : Promise.resolve(null),
      isOrgAdmin
        ? supabase.from("print_policies").select("id", { count: "exact", head: true }).eq("organization_id", orgId)
        : Promise.resolve(null),
      isOrgAdmin
        ? supabase.from("quotas").select("id", { count: "exact", head: true }).eq("organization_id", orgId)
        : Promise.resolve(null),
    ]);

  const agents = (agentsRes.data ?? []).map((a) => ({ id: a.id, name: a.name, lastSeenAt: a.last_seen_at }));
  // printer_profiles has no organization_id of its own: scope through this org's agents.
  const profilesRes =
    isOrgAdmin && agents.length > 0
      ? await supabase
          .from("printer_profiles")
          .select("id", { count: "exact", head: true })
          .in(
            "agent_id",
            agents.map((a) => a.id),
          )
      : null;
  const printers = (printersRes.data ?? []).map((p) => ({ id: p.id, name: p.name, status: p.status }));

  // Devices that need a look (admins only): open help requests, or connected
  // but nothing printed for a while.
  let stuckDevices: number | null = null;
  if (isOrgAdmin) {
    const devices = devicesRes?.data ?? [];
    const openByDevice: Record<string, number> = {};
    if (devices.length > 0) {
      const { data: issues } = await supabase
        .from("device_issues")
        .select("device_id")
        .eq("status", "open")
        .in(
          "device_id",
          devices.map((d) => d.id),
        )
        .limit(500);
      for (const i of issues ?? []) openByDevice[i.device_id] = (openByDevice[i.device_id] ?? 0) + 1;
    }
    stuckDevices = devices.filter((d) => stuckReason(d, openByDevice[d.id] ?? 0, now)).length;
  }

  const attention = buildAttentionItems({
    now,
    pendingApprovals: { count: pending.count ?? 0, oldestCreatedAt: pending.data?.[0]?.created_at ?? null },
    failed: {
      count: failed.count ?? 0,
      recent: (failed.data ?? []).map((j) => ({ name: j.original_file_name, errorMessage: j.error_message })),
    },
    agents,
    printers,
    heldCount: held.count ?? 0,
    waitingForPrinter: { count: waiting.count ?? 0 },
    stuckDevices,
  });

  const rightNow = buildRightNow({
    now,
    agents,
    printers,
    activeJobs: (active.data ?? []).map((j) => ({
      id: j.id,
      jobNumber: j.job_number,
      printerId: j.printer_id,
      status: j.status,
      pages: j.source_pdf_pages,
      copies: j.copies,
    })),
  });

  const recentRows = (recent.data ?? []).map((j) => ({
    id: j.id,
    href: routes.job(j.id),
    name: j.original_file_name,
    status: j.status,
    errorMessage: j.error_message,
    meta: jobMetaLine({ pages: j.source_pdf_pages, copies: j.copies, createdAt: j.created_at }, now),
  }));

  // First-run checklist, only while required setup is unfinished.
  const steps = isOrgAdmin
    ? setupChecklist(
        {
          agents: agents.length,
          onlineAgents: agents.filter((a) => !isStale(a.lastSeenAt, now, 5 * 60_000)).length,
          printers: printers.length,
          printerProfiles: profilesRes?.count ?? 0,
          members: membersRes?.count ?? 0,
          policies: policiesRes?.count ?? 0,
          quotas: quotasRes?.count ?? 0,
        },
        { agents: routes.adminAgents, printersSetup: routes.adminPrintersSetup, users: routes.adminUsers, policies: routes.adminPolicies },
      )
    : [];
  const showSetup = isOrgAdmin && !isSetupComplete(steps);

  return (
    <div>
      <AutoRefresh />
      <PageHeader
        title={`Hi, ${firstName(session.profile.display_name, session.email)}`}
        description="Here is what needs you and what is printing right now."
      />
      {showSetup && <SetupCard steps={steps} />}
      <div data-tour="admin-overview-stats">
        <NeedsAttention items={attention} />
      </div>
      <RightNow rows={rightNow} />
      <div className="mb-6">
        <BigPrintCard hint="Upload a PDF and choose a printer and options." />
      </div>
      <section aria-labelledby="recent">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent" className="text-base font-bold tracking-[-0.01em]">
            Recent jobs
          </h2>
          <ButtonLink href={routes.adminReports} variant="ghost" size="sm">
            View all
          </ButtonLink>
        </div>
        <RecentJobs jobs={recentRows} emptyText="No prints yet. Jobs show up here as soon as someone prints." />
      </section>
    </div>
  );
}
