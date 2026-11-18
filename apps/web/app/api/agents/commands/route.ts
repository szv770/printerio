import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { listCommandsForAgent } from "@/lib/agent-commands";

/** See docs/agent-api.md. `command` is always one of the fixed allow-listed
 *  values (docs/architecture.md sec 12) - never a raw string to execute.
 *  Current Agents get the same list inside `GET /api/agents/jobs/claimable?commands=1` instead (lib/agent-commands.ts);
 *  this route stays for older Agents and as the fallback. */
export async function GET(request: Request) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");

  const commands = await listCommandsForAgent(createServiceRoleClient(), agent.id);
  if (!commands) return apiError(500, "internal_error", "Failed to list commands.");
  return Response.json({ commands });
}
