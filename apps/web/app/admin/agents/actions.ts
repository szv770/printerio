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
