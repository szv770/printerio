import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import {
  describeAgentConnection,
  describeAgentVersion,
  deriveAgentActivity,
  summarizeUsageByProfile,
} from "@/lib/agent-detail";
import { AgentDetail } from "./AgentDetail";

/** How many recently-issued remote commands to show. Enough to see whether the
 *  button you just pressed was actually picked up and what the Agent answered,
 *  not an audit log (audit_logs is that, and /admin/audit shows it). */
const RECENT_COMMAND_LIMIT = 10;

/**
 * The per-Agent detail view. The Agents list can only say name/status/
 * version/last-seen, which answers none of the questions that actually come
 * up about a registered machine: which physical PC is this, which print
 * queues does it drive, are those queues being used, is it up to date, and
 * can I hold it for a few minutes without disabling it outright.
 *
 * Every query below is scoped by `organization_id` taken from the session -
 * never from the URL - and runs through the RLS-enforced client
 * (docs/architecture.md sec 3): a mistyped or guessed agent id in the URL
 * simply returns nothing and 404s here, rather than reaching another
 * organization's row.
 */
export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!agent) notFound();

  // Queues (printer_profiles) mapped to this Agent, with the printer each one
  // belongs to. The inner join on printers is also a second org guard: a
  // profile only comes back if its printer is in this organization.
  const { data: profileRows } = await supabase
    .from("printer_profiles")
    .select("*, printers!inner(id, name, status, last_status_at, organization_id)")
    .eq("agent_id", agentId)
    .eq("printers.organization_id", orgId)
    .order("created_at", { ascending: true });

  const profiles = profileRows ?? [];
  const profileIds = profiles.map((profile) => profile.id);

  // Simple usage signals only (count + last used), per the same reasoning as
  // admin/users/[userId]'s activity card: a count and a max(created_at)
  // answer "is this queue in use, and when did it last do anything" without
  // inventing an analytics surface.
  const { data: profileJobs } = profileIds.length
    ? await supabase
        .from("print_jobs")
        .select("printer_profile_id, created_at, status")
        .eq("organization_id", orgId)
        .in("printer_profile_id", profileIds)
    : { data: [] };

  const [{ data: leasedJobs }, { data: commands }, { data: pausedByProfile }] = await Promise.all([
    supabase
      .from("print_jobs")
      .select("updated_at")
      .eq("organization_id", orgId)
      .eq("lease_owner_agent_id", agentId)
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("remote_commands")
      .select("id, command, status, result, created_at, completed_at")
      .eq("organization_id", orgId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(RECENT_COMMAND_LIMIT),
    agent.paused_by
      ? supabase.from("profiles").select("display_name, email").eq("id", agent.paused_by).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const usageByProfile = summarizeUsageByProfile(profileIds, profileJobs ?? []);
  const activity = deriveAgentActivity(agent.last_seen_at, leasedJobs ?? [], commands ?? []);
  const version = describeAgentVersion(agent.version);
  // Deliberately impure (Date.now()) - this is a Server Component computing a
  // fresh snapshot per request, the same rationale as admin/page.tsx's
  // onlineCutoff and admin/users/[userId]'s activity window.
  // eslint-disable-next-line react-hooks/purity
  const connection = describeAgentConnection(agent, Date.now());

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={routes.adminAgents}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to print servers
      </Link>

      <PageHeader
        title={agent.name}
        description={agent.hostname ? `${agent.hostname} — ${connection.detail}` : connection.detail}
      />

      <AgentDetail
        agent={agent}
        connection={connection}
        version={version}
        activity={activity}
        pausedByLabel={pausedByProfile?.display_name ?? pausedByProfile?.email ?? null}
        queues={profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          windowsQueueName: profile.windows_queue_name,
          rawTarget: profile.output_mode === "raw" ? `${profile.raw_host}:${profile.raw_port}` : null,
          printerId: profile.printers.id,
          printerName: profile.printers.name,
          printerStatus: profile.printers.status,
          printerStatusAt: profile.printers.last_status_at,
          usage: usageByProfile[profile.id] ?? { totalJobs: 0, printedJobs: 0, lastUsedAt: null },
        }))}
        recentCommands={(commands ?? []).map((command) => ({
          id: command.id,
          command: command.command,
          status: command.status,
          createdAt: command.created_at,
          completedAt: command.completed_at,
          result: command.result,
        }))}
        canManage={session.membership.role === "org_admin"}
      />

      {profiles.length === 0 && (
        <p className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-[var(--color-text-2)]">
          No print queues use this print server yet. Add one from the{" "}
          <Link href={routes.adminPrinters} className="font-medium text-[var(--color-primary)] underline">
            Printers
          </Link>{" "}
          page and it will show up here.
        </p>
      )}
    </div>
  );
}
