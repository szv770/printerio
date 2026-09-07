"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
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
  if (error) return { error: error.message };

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
  if (error || !agent) return { error: error?.message ?? "Agent not found." };

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
  if (error) return { error: error.message };

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
  if (error) return { error: error.message };

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
  if (error) return { error: error.message };

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
