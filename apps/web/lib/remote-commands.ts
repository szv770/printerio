import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { REMOTE_COMMANDS, type RemoteCommand } from "@printio/shared";

/**
 * Shared by app/api/admin/commands/route.ts (called by any external client
 * with an admin session) and the admin dashboard's own Server Actions
 * (PrintersPanel/AgentsPanel "Refresh status"/"Restart queue"/etc. buttons) -
 * one implementation of "insert an allow-listed remote_commands row and
 * audit-log it" rather than two. See docs/architecture.md sec 12/18/48:
 * `command` is always one of the fixed REMOTE_COMMANDS - there is no
 * arbitrary shell/PowerShell execution path anywhere in this system.
 */
export interface IssueRemoteCommandParams {
  organizationId: string;
  issuedBy: string;
  agentId: string;
  printerId?: string | null;
  command: string;
  payload?: Record<string, unknown>;
}

export type IssueRemoteCommandResult = { ok: true; commandId: string } | { ok: false; error: string };

export async function issueRemoteCommand(
  supabase: SupabaseClient<Database>,
  params: IssueRemoteCommandParams,
): Promise<IssueRemoteCommandResult> {
  if (!REMOTE_COMMANDS.includes(params.command as RemoteCommand)) {
    return { ok: false, error: `command must be one of: ${REMOTE_COMMANDS.join(", ")}` };
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id, organization_id")
    .eq("id", params.agentId)
    .maybeSingle();
  if (!agent || agent.organization_id !== params.organizationId) {
    return { ok: false, error: "Agent not found." };
  }

  const { data: inserted, error } = await supabase
    .from("remote_commands")
    .insert({
      organization_id: params.organizationId,
      agent_id: params.agentId,
      printer_id: params.printerId ?? null,
      command: params.command,
      payload: (params.payload ?? {}) as Json,
      issued_by: params.issuedBy,
    })
    .select("id")
    .single();
  if (error?.code === "23514") {
    // check_violation on remote_commands_command_check: the code knows this command but the database has not
    // been told yet (a newer command name than the applied migrations). Say so plainly instead of "failed".
    return {
      ok: false,
      error: "That request is not available yet: the database needs one update first (migration 0036_remote_command_get_logs.sql). Ask whoever manages Printio to apply it, then try again.",
    };
  }
  if (error || !inserted) return { ok: false, error: "Failed to issue command." };

  await supabase.from("audit_logs").insert({
    organization_id: params.organizationId,
    actor_id: params.issuedBy,
    action: "remote_command.issued",
    target_type: "remote_commands",
    target_id: inserted.id,
    metadata: { command: params.command, agentId: params.agentId },
  });

  return { ok: true, commandId: inserted.id };
}
