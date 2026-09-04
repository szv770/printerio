import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

/** See docs/agent-api.md. `command` is always one of the fixed allow-listed
 *  values (docs/architecture.md sec 12) - never a raw string to execute. */
export async function GET(request: Request) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");

  const supabase = createServiceRoleClient();
  const { data: commands, error } = await supabase
    .from("remote_commands")
    .select("id, command, payload")
    .eq("agent_id", agent.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) return apiError(500, "internal_error", "Failed to list commands.");
  return Response.json({ commands: commands ?? [] });
}
