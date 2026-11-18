import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { logger } from "@/lib/logger";

/** A command the Agent picked up (acknowledged) but never answered for this long is offered again (it crashed mid-way). */
export const REDELIVER_ACKNOWLEDGED_AFTER_MS = 15 * 60_000;

const COMMANDS_LIMIT = 20;

export interface AgentCommandEnvelope {
  id: string;
  command: string;
  payload: unknown;
}

/**
 * The remote commands waiting for this agent, oldest first (at most 20; the rest follow once these are answered), as
 * `GET /api/agents/commands` returns them AND as `GET /api/agents/jobs/claimable?commands=1` embeds them. Handing a
 * pending command out marks it acknowledged ("Running..." on the admin page); that marking is best effort and never
 * stops the agent getting its work. Returns null when the lookup itself failed.
 */
export async function listCommandsForAgent(supabase: SupabaseClient<Database>, agentId: string): Promise<AgentCommandEnvelope[] | null> {
  const staleIso = new Date(Date.now() - REDELIVER_ACKNOWLEDGED_AFTER_MS).toISOString();
  const { data: commands, error } = await supabase
    .from("remote_commands")
    .select("id, command, payload, status")
    .eq("agent_id", agentId)
    .or(`status.eq.pending,and(status.eq.acknowledged,created_at.lt.${staleIso})`)
    .order("created_at", { ascending: true })
    // Bounded: the rest are offered on the next poll once these are answered.
    .limit(COMMANDS_LIMIT);

  if (error) return null;
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
      if (markError) logger.warn("could not mark commands as picked up", { agentId, error: markError.message });
    } catch (err) {
      logger.warn("could not mark commands as picked up", { agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return list.map((c) => ({ id: c.id, command: c.command, payload: c.payload }));
}
