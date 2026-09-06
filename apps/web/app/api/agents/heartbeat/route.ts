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
 *
 * The raw `queues[]` array is also persisted in full onto
 * `agents.discovered_queues` (overwritten each heartbeat, not accumulated -
 * see that column's comment) regardless of whether any queue matches an
 * existing printer_profile. That's what lets the guided setup wizard
 * (app/admin/printers/setup) offer a real dropdown of this Agent's actual
 * Windows queue names when registering a *new* profile, instead of an admin
 * hand-typing one from memory.
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
  const nowIso = new Date().toISOString();

  // discovered_queues is only ever overwritten wholesale here, mirroring the
  // last_seen_at/version update-in-place style on this same row - it reflects
  // "what this Agent reported most recently," never a growing history. A
  // heartbeat with no queues[] (or an empty array) leaves it untouched -
  // silence isn't the same as "this Agent now sees zero queues" (see
  // supabase/migrations/0018_agents_discovered_queues.sql).
  const { error } = await supabase
    .from("agents")
    .update({
      last_seen_at: nowIso,
      version: body.version ?? null,
      ...(body.queues && body.queues.length > 0
        ? { discovered_queues: body.queues.map((q) => ({ ...q, reportedAt: nowIso })) }
        : {}),
    })
    .eq("id", agent.id);
  if (error) return apiError(500, "internal_error", "Failed to record heartbeat.");

  if (body.queues && body.queues.length > 0) {
    const { data: profiles } = await supabase
      .from("printer_profiles")
      .select("printer_id, windows_queue_name")
      .eq("agent_id", agent.id);

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
