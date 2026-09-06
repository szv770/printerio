import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

interface HeartbeatBody {
  version?: string;
  queues?: Array<{ windowsQueueName: string; driverName?: string; portName?: string; status?: string }>;
}

/** Maps the Agent's queue-level status vocabulary (apps/agent/src/printer-manager.ts)
 *  down to the four values printers.status actually supports. "ready" is the
 *  only status that counts as fully online; anything else that isn't a plain
 *  "offline"/"unknown" is folded into "error" (paper_out/paused both mean "this
 *  queue needs attention", and the DB doesn't have a slot for every nuance). */
function toPrinterStatus(agentQueueStatus: string | undefined): "unknown" | "online" | "offline" | "error" {
  switch (agentQueueStatus) {
    case "ready":
      return "online";
    case "offline":
      return "offline";
    case "unknown":
    case undefined:
      return "unknown";
    default:
      return "error"; // "error" | "paper_out" | "paused" | anything unrecognized
  }
}

/**
 * See docs/agent-api.md. `queues[]` is informational printer-discovery
 * reporting (sec 11/38) - it does not auto-create printer_profiles - but it
 * IS the only signal Printio has for printers.status, so any queue that
 * matches one of this agent's printer_profiles updates that printer's
 * status/last_status_at. A printer with no matching queue in this report
 * (or no queues reported at all) is simply left untouched, not marked
 * offline - silence isn't the same as a confirmed offline status.
 */
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

  if (body.queues && body.queues.length > 0) {
    const { data: profiles } = await supabase
      .from("printer_profiles")
      .select("printer_id, windows_queue_name")
      .eq("agent_id", agent.id);

    const nowIso = new Date().toISOString();
    for (const queue of body.queues) {
      const profile = profiles?.find((p) => p.windows_queue_name === queue.windowsQueueName);
      if (!profile) continue; // queue not yet registered as a printer_profile - nothing to update
      await supabase
        .from("printers")
        .update({ status: toPrinterStatus(queue.status), last_status_at: nowIso })
        .eq("id", profile.printer_id);
    }
  }

  return Response.json({ ok: true, serverTime: new Date().toISOString() });
}
