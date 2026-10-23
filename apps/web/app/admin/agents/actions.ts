"use server";

import { agentSupportsCheckOnly } from "@/lib/update-progress";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/action-errors";
import { routes } from "@/lib/routes";
import { generateEnrollmentCode } from "@/lib/auth/invitations";
import { issueRemoteCommand } from "@/lib/remote-commands";

export interface AgentActionState {
  error?: string;
  enrollmentCode?: string;
}

/** Registers a new agent record with a one-time enrollment code (24h TTL) -
 *  the operator runs `register --code=<this>` on the Windows machine. */
export async function createAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  const code = generateEnrollmentCode();
  const supabase = await createClient();
  const { error } = await supabase.from("agents").insert({
    organization_id: session.membership.organization_id,
    name,
    enrollment_code: code,
    enrollment_code_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    status: "pending",
  });
  if (error) return { error: describeDatabaseError(error, "Couldn't register that agent.") };

  revalidatePath(routes.adminAgents);
  return { enrollmentCode: code };
}

/** Rotation: invalidates the current device secret and issues a fresh
 *  enrollment code - the Agent must re-register (docs/architecture.md sec 4). */
export async function rotateAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const code = generateEnrollmentCode();
  const supabase = await createClient();
  const { data: agent, error } = await supabase
    .from("agents")
    .update({
      device_secret_hash: null,
      enrollment_code: code,
      enrollment_code_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      status: "pending",
    })
    .eq("id", agentId)
    .eq("organization_id", session.membership.organization_id)
    .select("id")
    .single();
  if (error || !agent) {
    return { error: error ? describeDatabaseError(error, "Couldn't rotate that agent's credential.") : "Agent not found." };
  }

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "agent.credential_rotated",
    target_type: "agents",
    target_id: agentId,
    metadata: {},
  });

  revalidatePath(routes.adminAgents);
  return { enrollmentCode: code };
}

export async function disableAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const { error } = await supabase
    .from("agents")
    .update({ status: "disabled" })
    .eq("id", agentId)
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't disable that agent.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "agent.disabled",
    target_type: "agents",
    target_id: agentId,
    metadata: {},
  });

  revalidatePath(routes.adminAgents);
  return {};
}

/** "Restart service" button - a last-resort, whole-machine recovery action.
 *  See docs/architecture.md sec 12/18. */
export async function restartAgentServiceAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    command: "RESTART_AGENT_SERVICE",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgents);
  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/** "Clear temp files" button - only ever deletes files under this Agent's own
 *  configured local storage path (see apps/agent/src/commands.ts). */
export async function clearAgentTempFilesAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    command: "CLEAR_AGENT_TEMP_FILES",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgents);
  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/**
 * "Pause"/"Resume" - the freeze switch on app/admin/agents/[agentId].
 *
 * Writing `agents.paused` is the WHOLE mechanism: the two agent-facing routes
 * that hand out work (`/api/agents/jobs/claimable` and
 * `/api/agents/jobs/[jobId]/claim`) read it on every call and refuse a paused
 * Agent, so the pause takes effect on the Agent's very next poll (~15s)
 * whether or not the Agent itself cooperates. The Agent is separately told
 * `paused: true` in its heartbeat response so it stops asking at all, but
 * that is only an optimization on top.
 *
 * Deliberately NOT done here: cancelling or reclaiming jobs the Agent already
 * holds a lease on. Those finish printing normally - "pause" means "stop
 * taking new work", and yanking a job out of a machine mid-print would be a
 * much bigger, much less recoverable action wearing a small button.
 */
export async function pauseAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  return setAgentPaused(formData, true);
}

export async function resumeAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  return setAgentPaused(formData, false);
}

/** Shared body of pause/resume. Not exported - a "use server" file may only export async functions, and this is an implementation detail of the two above regardless. */
async function setAgentPaused(formData: FormData, paused: boolean): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("agents")
    .update({
      paused,
      paused_at: paused ? new Date().toISOString() : null,
      paused_by: paused ? session.userId : null,
    })
    .eq("id", agentId)
    .eq("organization_id", session.membership.organization_id)
    .select("id")
    .maybeSingle();
  if (error) {
    return { error: describeDatabaseError(error, paused ? "Couldn't pause that agent." : "Couldn't resume that agent.") };
  }
  if (!updated) return { error: "Agent not found." };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: paused ? "agent.paused" : "agent.resumed",
    target_type: "agents",
    target_id: agentId,
    metadata: {},
  });

  revalidatePath(routes.adminAgents);
  revalidatePath(routes.adminAgentDetail(agentId));
  revalidatePath(routes.adminPrinters);
  return {};
}

/** "Restart print queue" from the per-Agent detail page - the same fixed
 *  allow-listed command the Printers page issues, addressed by the queue
 *  (printer_profile) row it was clicked on. Whole-machine in effect: on
 *  Windows this restarts the Print Spooler service, which affects every queue
 *  on that machine (docs/architecture.md sec 11). */
export async function restartAgentPrintQueueAction(
  _prev: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");
  const printerId = String(formData.get("printerId") ?? "");
  const printerProfileId = String(formData.get("printerProfileId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    printerId: printerId || null,
    command: "RESTART_PRINT_QUEUE",
    payload: { printerProfileId },
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/** "Update this server" - issues the fixed CHECK_FOR_UPDATE command (no payload). What the
 *  Agent does with it is entirely Agent-side and entirely hardcoded (git pull
 *  --ff-only + pnpm install in its own checkout, a restart of the gateway service, then a graceful self-restart,
 *  or a clear "this isn't a git checkout" answer) - see
 *  apps/agent/src/self-update.ts. Nothing about the update sequence is sent
 *  from here; this issues a command NAME, never a command STRING. */
export async function checkAgentForUpdateAction(
  _prev: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    command: "CHECK_FOR_UPDATE",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/** Quiet "is there an update?" check run when the Print server page opens. Same fixed CHECK_FOR_UPDATE command, but the
 *  payload is the one literal { mode: "check_only" }: the Agent only fetches and compares, it pulls and installs
 *  nothing. No form value can reach the payload. Admin only. */
export async function checkAgentUpdateAvailableAction(
  _prev: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  // An Agent older than the check_only feature would read this payload as "update now" and do a full update.
  // Only send it to an Agent that has itself reported a new enough version.
  const { data: target } = await supabase.from("agents").select("version").eq("id", agentId).maybeSingle();
  if (!agentSupportsCheckOnly(target?.version)) {
    return { error: "This print server has to be updated once before it can check for updates by itself." };
  }
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    command: "CHECK_FOR_UPDATE",
    payload: { mode: "check_only" },
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/** "Get recent logs" - issues the fixed GET_LOGS command (no payload). The Agent reads the tail of its OWN fixed log
 *  files (apps/agent/src/log-collector.ts), masks secrets and answers; nothing about which files to read is sent from
 *  here. Admin only; audited by issueRemoteCommand (who asked, which agent). */
export async function getAgentLogsAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    command: "GET_LOGS",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/** "Refresh printer status" from the detail page - asks the Agent to
 *  re-enumerate its Windows queues and heartbeat immediately, rather than
 *  waiting out the poll interval. */
export async function refreshAgentPrinterStatusAction(
  _prev: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();
  const result = await issueRemoteCommand(supabase, {
    organizationId: session.membership.organization_id,
    issuedBy: session.userId,
    agentId,
    command: "REFRESH_PRINTER_STATUS",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(routes.adminAgentDetail(agentId));
  return {};
}

/** Renames an agent's display name - purely cosmetic, no effect on its
 *  credential, printer_profiles mappings, or Windows queue names. */
export async function renameAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("agents")
    .update({ name })
    .eq("id", agentId)
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't rename that agent.") };

  revalidatePath(routes.adminAgents);
  return {};
}

/**
 * Permanently removes an agent record. Only allowed for a `pending` (never
 * successfully registered - e.g. a mistyped test/duplicate) or already
 * `disabled` agent - an `active` agent must be disabled first (same
 * decommission order docs/agent-install.md sec 8 already documents), so this
 * can never silently pull the credential out from under a machine that's
 * still actually printing.
 *
 * printer_profiles.agent_id is `on delete restrict` (0002_printing_tables.sql)
 * specifically so a profile can never end up pointing at a row that no
 * longer exists - checked here first for a clear, actionable error instead
 * of a raw FK-violation message; reassign or delete those profiles first if
 * the printer itself is genuinely going away, per that same doc section.
 */
export async function deleteAgentAction(_prev: AgentActionState, formData: FormData): Promise<AgentActionState> {
  const session = await requireOrgRole(["org_admin"]);
  const agentId = String(formData.get("agentId") ?? "");

  const supabase = await createClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("status")
    .eq("id", agentId)
    .eq("organization_id", session.membership.organization_id)
    .maybeSingle();
  if (!agent) return { error: "Agent not found." };
  if (agent.status === "active") {
    return { error: "Disable this agent first, then delete it - an active agent must not be removed out from under a machine that may still be printing." };
  }

  const { count } = await supabase
    .from("printer_profiles")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId);
  if (count && count > 0) {
    return {
      error: `${count} printer profile${count === 1 ? "" : "s"} still point at this agent - reassign or delete ${count === 1 ? "it" : "them"} first (Printers page).`,
    };
  }

  const { error } = await supabase
    .from("agents")
    .delete()
    .eq("id", agentId)
    .eq("organization_id", session.membership.organization_id);
  if (error) return { error: describeDatabaseError(error, "Couldn't delete that agent.") };

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "agent.deleted",
    target_type: "agents",
    target_id: agentId,
    metadata: {},
  });

  revalidatePath(routes.adminAgents);
  return {};
}
