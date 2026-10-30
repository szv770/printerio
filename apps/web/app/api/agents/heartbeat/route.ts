import type { Database } from "@/lib/database.types";
import { apiError } from "@/lib/api-errors";
import { authenticateAgentRequest } from "@/lib/agent-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { narrowProbeReports, printerUpdateFromReport, rawPrinterTargets } from "@/lib/printers/probe-report";

interface HeartbeatBody {
  version?: string;
  queues?: Array<{ windowsQueueName: string; driverName?: string; portName?: string; status?: string }>;
  /** Optional (older Agent builds don't send it): what each direct-port printer said about itself. Display only; narrowed in lib/printers/probe-report.ts. */
  rawPrinters?: unknown;
  /** Optional (older Agent builds don't send it) - see apps/agent/src/machine-info.ts. */
  machine?: {
    hostname?: unknown;
    osVersion?: unknown;
    ipAddresses?: unknown;
    isGitCheckout?: unknown;
  };
}

const MAX_MACHINE_FIELD_LENGTH = 200;

/** A printer whose status is unchanged still gets its "last heard from" stamp refreshed this often. */
const STATUS_STAMP_REFRESH_MS = 5 * 60_000;

/** True when the stored discovered_queues equal the reported queues, ignoring the per-queue reportedAt stamp. */
function sameQueues(stored: unknown, incoming: unknown[]): boolean {
  if (!Array.isArray(stored) || stored.length !== incoming.length) return false;
  const strip = (q: unknown) => {
    if (typeof q !== "object" || q === null) return q;
    const { reportedAt: _ignored, ...rest } = q as Record<string, unknown>;
    return rest;
  };
  return JSON.stringify(stored.map(strip)) === JSON.stringify(incoming.map(strip));
}
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
  //
  // Only last_seen_at is written every time. version / discovered_queues / machine fields are written only when
  // they differ from what authentication already loaded for this agent (per-queue reportedAt is ignored in the
  // comparison), so a steady-state heartbeat is one tiny UPDATE instead of a rewrite of the whole row.
  const reported = agent.reported;
  const agentUpdate: Record<string, unknown> = { last_seen_at: nowIso };
  const newVersion = body.version ?? null;
  if (!reported || reported.version !== newVersion) agentUpdate.version = newVersion;
  if (body.queues && body.queues.length > 0 && (!reported || !sameQueues(reported.discovered_queues, body.queues))) {
    agentUpdate.discovered_queues = body.queues.map((q) => ({ ...q, reportedAt: nowIso }));
  }
  for (const [column, value] of Object.entries(buildMachineUpdate(body.machine))) {
    if (!reported || JSON.stringify(reported[column as keyof typeof reported]) !== JSON.stringify(value)) agentUpdate[column] = value;
  }

  // One read of this agent's profiles (with each printer's current status) serves both the queue-status updates and
  // the direct-port targets; it is independent of the agents UPDATE, so they run together.
  const [{ error }, { data: profiles }] = await Promise.all([
    supabase.from("agents").update(agentUpdate as Database["public"]["Tables"]["agents"]["Update"]).eq("id", agent.id),
    supabase
      .from("printer_profiles")
      .select("printer_id, windows_queue_name, output_mode, raw_host, raw_port, printers(status, last_status_at)")
      .eq("agent_id", agent.id),
  ]);
  if (error) return apiError(500, "internal_error", "Failed to record heartbeat.");

  if (body.queues && body.queues.length > 0) {
    // Only printers whose status changed (or whose "last heard from" stamp is stale) are written, grouped by new
    // status into one UPDATE each, scoped to this organization.
    const staleBefore = Date.now() - STATUS_STAMP_REFRESH_MS;
    const idsByStatus = new Map<string, string[]>();
    for (const queue of body.queues) {
      const profile = profiles?.find((p) => p.windows_queue_name === queue.windowsQueueName);
      if (!profile) continue; // queue not yet registered as a printer_profile - nothing to update
      const status = toPrinterStatus(queue.status);
      const printer = Array.isArray(profile.printers) ? profile.printers[0] : profile.printers;
      const stampedAt = printer?.last_status_at ? Date.parse(printer.last_status_at) : 0;
      if (printer && printer.status === status && stampedAt > staleBefore) continue;
      const ids = idsByStatus.get(status) ?? [];
      if (!ids.includes(profile.printer_id)) ids.push(profile.printer_id);
      idsByStatus.set(status, ids);
    }
    await Promise.all(
      [...idsByStatus].map(([status, ids]) =>
        supabase
          .from("printers")
          .update({ status: status as ReturnType<typeof toPrinterStatus>, last_status_at: nowIso })
          .in("id", ids)
          .eq("organization_id", agent.organizationId),
      ),
    );
  }

  // Direct-port printers: record what each one said about itself (only printers that belong to THIS agent, inside its
  // organization), and tell the agent which printers to ask about next time. Display only (lib/printers/probe-report.ts).
  const rawTargets = rawPrinterTargets(profiles ?? []);
  await Promise.all(
    narrowProbeReports(body.rawPrinters, new Set(rawTargets.map((t) => t.printerId))).map((report) =>
      supabase.from("printers").update(printerUpdateFromReport(report, nowIso)).eq("id", report.printerId).eq("organization_id", agent.organizationId),
    ),
  );

  // Tell the Agent whether an admin currently has it paused, so it can stop
  // asking for work client-side too (apps/agent/src/health-monitor.ts). This
  // is a courtesy, NOT the enforcement: /api/agents/jobs/claimable and
  // .../[jobId]/claim independently refuse a paused Agent, so ignoring this
  // field buys a modified Agent nothing.
  return Response.json({ ok: true, serverTime: new Date().toISOString(), paused: agent.paused, rawPrinters: rawTargets });
}
