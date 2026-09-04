import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

interface HeartbeatBody {
  version?: string;
  queues?: Array<{ windowsQueueName: string; driverName?: string; portName?: string; status?: string }>;
}

/** See docs/agent-api.md - informational only; does not auto-create printer_profiles. */
export async function POST(request: Request) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");

  let body: HeartbeatBody;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("agents")
    .update({ last_seen_at: new Date().toISOString(), version: body.version ?? null })
    .eq("id", agent.id);
  if (error) return apiError(500, "internal_error", "Failed to record heartbeat.");

  return Response.json({ ok: true, serverTime: new Date().toISOString() });
}
