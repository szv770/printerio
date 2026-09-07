import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

interface HeartbeatBody {
  version?: string;
  queues?: Array<{ windowsQueueName: string; driverName?: string; portName?: string; status?: string }>;
  /** Optional (older Agent builds don't send it) - see apps/agent/src/machine-info.ts. */
  machine?: {
    hostname?: unknown;
    osVersion?: unknown;
    ipAddresses?: unknown;
    isGitCheckout?: unknown;
  };
}

const MAX_MACHINE_FIELD_LENGTH = 200;
const MAX_IP_ADDRESSES = 20;

/** Trims and length-caps a self-reported string. Returns undefined (leave the column alone) for anything that isn't a usable string. */
function sanitizeReportedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_MACHINE_FIELD_LENGTH);
}

/**
 * The Agent's self-reported machine details, narrowed to what the columns
 * accept. These values are DISPLAY-ONLY (docs/architecture.md sec 3.2:
 * nothing that affects authorization is ever taken from a request body) -
 * they are never used to authenticate, authorize, or route anything, which
 * is what makes accepting a self-report safe at all. They are still bounded
 * here so a malfunctioning or hostile Agent can't write unbounded text into
 * its own row. A field that isn't present/usable is omitted from the UPDATE
 * entirely rather than written as null - a heartbeat that says nothing about
 * hostname must not erase a hostname reported a minute ago.
 */
function buildMachineUpdate(machine: HeartbeatBody["machine"]): Record<string, unknown> {
  if (!machine || typeof machine !== "object") return {};
  const update: Record<string, unknown> = {};

  const hostname = sanitizeReportedString(machine.hostname);
  if (hostname) update.hostname = hostname;

  const osVersion = sanitizeReportedString(machine.osVersion);
  if (osVersion) update.os_version = osVersion;

  if (Array.isArray(machine.ipAddresses)) {
    const addresses = machine.ipAddresses
      .map((address) => sanitizeReportedString(address))
      .filter((address): address is string => Boolean(address))
      .slice(0, MAX_IP_ADDRESSES);
    // An empty array IS meaningful here (an Agent that genuinely sees no
    // external interface right now), unlike a missing field.
    update.ip_addresses = addresses;
  }

  if (typeof machine.isGitCheckout === "boolean") update.is_git_checkout = machine.isGitCheckout;

  return update;
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
      ...buildMachineUpdate(body.machine),
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

  // Tell the Agent whether an admin currently has it paused, so it can stop
  // asking for work client-side too (apps/agent/src/health-monitor.ts). This
  // is a courtesy, NOT the enforcement: /api/agents/jobs/claimable and
  // .../[jobId]/claim independently refuse a paused Agent, so ignoring this
  // field buys a modified Agent nothing.
  return Response.json({ ok: true, serverTime: new Date().toISOString(), paused: agent.paused });
}
