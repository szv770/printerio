import { apiError } from "@/lib/api-errors";
import { requireOrgRole, AuthError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { REMOTE_COMMANDS, type RemoteCommand } from "@printos/shared";
import type { Json } from "@/lib/database.types";

interface IssueCommandBody {
  agentId?: string;
  printerId?: string;
  command?: string;
  payload?: Record<string, unknown>;
}

/**
 * Admin-issued remote command (docs/architecture.md sec 12/18/48). `command`
 * must be one of the fixed REMOTE_COMMANDS - there is no arbitrary
 * shell/PowerShell execution path anywhere in this system.
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireOrgRole(["org_admin"]);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code === "UNAUTHENTICATED" ? 401 : 403, err.code, err.message);
    throw err;
  }

  let body: IssueCommandBody;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }

  if (!body.command || !REMOTE_COMMANDS.includes(body.command as RemoteCommand)) {
    return apiError(400, "invalid_command", `command must be one of: ${REMOTE_COMMANDS.join(", ")}`);
  }
  if (!body.agentId) return apiError(400, "missing_agent", "agentId is required.");

  const supabase = await createClient();
  const { data: agent } = await supabase.from("agents").select("id, organization_id").eq("id", body.agentId).maybeSingle();
  if (!agent || agent.organization_id !== session.membership.organization_id) {
    return apiError(404, "not_found", "Agent not found.");
  }

  const { data: inserted, error } = await supabase
    .from("remote_commands")
    .insert({
      organization_id: session.membership.organization_id,
      agent_id: body.agentId,
      printer_id: body.printerId ?? null,
      command: body.command,
      payload: (body.payload ?? {}) as Json,
      issued_by: session.userId,
    })
    .select("id")
    .single();
  if (error || !inserted) return apiError(500, "internal_error", "Failed to issue command.");

  await supabase.from("audit_logs").insert({
    organization_id: session.membership.organization_id,
    actor_id: session.userId,
    action: "remote_command.issued",
    target_type: "remote_commands",
    target_id: inserted.id,
    metadata: { command: body.command, agentId: body.agentId },
  });

  return Response.json({ ok: true, commandId: inserted.id });
}
