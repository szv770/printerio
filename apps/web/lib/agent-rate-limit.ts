import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiError } from "@/lib/api-errors";
import { logger } from "@/lib/logger";

/** One budget per print server, shared by every poll-type route (claimable incl. the prepare hint, heartbeat, commands): the normal 2 s poll is 30 a minute (the old three-calls-per-cycle rollback mode is 90), so 120 leaves headroom while still stopping a runaway loop. */
export const AGENT_POLL_MAX_PER_WINDOW = 120;
export const AGENT_POLL_WINDOW_SECONDS = 60;

/**
 * Per-agent request limit for the poll routes (docs/CAPACITY-AND-BLAST-RADIUS.md). Returns a 429 Response (with Retry-After) when this agent is over
 * its budget, else null. Fails OPEN: if the limiter errors or throws, the request goes through (a broken guard must never stop printing).
 */
export async function checkAgentPollLimit(supabase: Pick<SupabaseClient, "rpc">, agentId: string, route: string): Promise<Response | null> {
  try {
    const { data: within, error } = await supabase.rpc("check_rate_limit", {
      p_key: `agent_poll:${agentId}`,
      p_max_count: AGENT_POLL_MAX_PER_WINDOW,
      p_window_seconds: AGENT_POLL_WINDOW_SECONDS,
    });
    if (error) {
      logger.error("agent poll rate limit check failed - letting the request through", { route, agentId, error: error.message });
      return null;
    }
    if (within === false) {
      const retryAfter = Math.max(1, AGENT_POLL_WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % AGENT_POLL_WINDOW_SECONDS));
      logger.warn("print server is polling too fast - answered 429", { route, agentId, retryAfterSeconds: retryAfter });
      const res = apiError(429, "rate_limited", "This print server is asking too often. Slow down and try again shortly.");
      res.headers.set("Retry-After", String(retryAfter));
      return res;
    }
  } catch (err) {
    logger.error("agent poll rate limit check failed - letting the request through", { route, agentId, error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}
