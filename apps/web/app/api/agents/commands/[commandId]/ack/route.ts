import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { Json } from "@/lib/database.types";

interface AckBody {
  status?: "completed" | "failed";
  result?: Record<string, unknown>;
}

export async function POST(request: Request, { params }: { params: Promise<{ commandId: string }> }) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");
  const { commandId } = await params;

  let body: AckBody;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  if (body.status !== "completed" && body.status !== "failed") {
    return apiError(400, "invalid_status", "status must be 'completed' or 'failed'.");
  }

  const supabase = createServiceRoleClient();
  const { data: command } = await supabase.from("remote_commands").select("*").eq("id", commandId).maybeSingle();
  if (!command || command.agent_id !== agent.id) return apiError(404, "not_found", "Command not found.");

  const { error } = await supabase
    .from("remote_commands")
    .update({ status: body.status, result: (body.result ?? null) as Json, completed_at: new Date().toISOString() })
    .eq("id", commandId);
  if (error) return apiError(500, "internal_error", "Failed to acknowledge command.");

  await supabase.from("audit_logs").insert({
    organization_id: command.organization_id,
    action: "remote_command.acknowledged",
    target_type: "remote_commands",
    target_id: commandId,
    metadata: { command: command.command, status: body.status, result: body.result ?? null } as Json,
  });

  return Response.json({ ok: true });
}
