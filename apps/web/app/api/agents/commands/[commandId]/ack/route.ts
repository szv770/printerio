import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { auditSafeResult } from "@/lib/command-result";
import type { Json } from "@/lib/database.types";

interface AckBody {
  status?: "completed" | "failed";
  result?: Record<string, unknown>;
}

/** GET_LOGS returns ~60 KB of text; nothing legitimate is anywhere near this. */
const MAX_RESULT_CHARS = 256 * 1024;

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
  if (body.result !== undefined && body.result !== null && (typeof body.result !== "object" || Array.isArray(body.result))) {
    return apiError(400, "invalid_result", "result must be a JSON object.");
  }
  if (body.result && JSON.stringify(body.result).length > MAX_RESULT_CHARS) {
    return apiError(413, "result_too_large", "The result is too large.");
  }

  const supabase = createServiceRoleClient();
  const { data: command } = await supabase.from("remote_commands").select("*").eq("id", commandId).maybeSingle();
  if (!command || command.agent_id !== agent.id) return apiError(404, "not_found", "Command not found.");

  // Conditional: a command already answered keeps its first answer (an Agent retry cannot overwrite or re-audit it).
  const { data: updated, error } = await supabase
    .from("remote_commands")
    .update({ status: body.status, result: (body.result ?? null) as Json, completed_at: new Date().toISOString() })
    .eq("id", commandId)
    .in("status", ["pending", "acknowledged"])
    .select("id");
  if (error) return apiError(500, "internal_error", "Failed to acknowledge command.");
  if (!updated || updated.length === 0) return Response.json({ ok: true, alreadyAnswered: true });

  await supabase.from("audit_logs").insert({
    organization_id: command.organization_id,
    action: "remote_command.acknowledged",
    target_type: "remote_commands",
    target_id: commandId,
    // Log content (GET_LOGS) never goes into the audit log; only a summary does.
    metadata: { command: command.command, status: body.status, result: auditSafeResult(command.command, body.result ?? null) } as Json,
  });

  return Response.json({ ok: true });
}
