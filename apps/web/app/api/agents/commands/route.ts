import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";

/** A command the Agent picked up (acknowledged) but never answered for this long is offered again (it crashed mid-way). */
export const REDELIVER_ACKNOWLEDGED_AFTER_MS = 15 * 60_000;

/** See docs/agent-api.md. `command` is always one of the fixed allow-listed
 *  values (docs/architecture.md sec 12) - never a raw string to execute. */
export async function GET(request: Request) {
  const agent = await authenticateAgentRequest(request);
  if (!agent) return apiError(401, "unauthenticated", "Invalid or revoked agent credentials.");

  const supabase = createServiceRoleClient();
  const staleIso = new Date(Date.now() - REDELIVER_ACKNOWLEDGED_AFTER_MS).toISOString();
  const { data: commands, error } = await supabase
    .from("remote_commands")
    .select("id, command, payload, status")
    .eq("agent_id", agent.id)
    .or(`status.eq.pending,and(status.eq.acknowledged,created_at.lt.${staleIso})`)
    .order("created_at", { ascending: true });

  if (error) return apiError(500, "internal_error", "Failed to list commands.");
  const list = commands ?? [];

  // Mark what we are handing out as picked up, so the admin page can say "Running..." instead of "waiting". A
  // conditional update (still pending) and best effort: failing to mark must never stop the Agent getting its work.
  const pendingIds = list.filter((c) => c.status === "pending").map((c) => c.id);
  if (pendingIds.length > 0) {
    try {
      const { error: markError } = await supabase
        .from("remote_commands")
        .update({ status: "acknowledged" })
        .in("id", pendingIds)
        .eq("status", "pending");
      if (markError) logger.warn("could not mark commands as picked up", { agentId: agent.id, error: markError.message });
    } catch (err) {
      logger.warn("could not mark commands as picked up", { agentId: agent.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return Response.json({ commands: list.map((c) => ({ id: c.id, command: c.command, payload: c.payload })) });
}
