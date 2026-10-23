/**
 * One-line summaries and status tones for the printers, print servers and
 * user devices pages. Plain words, no jargon. Pure; unit tested in
 * summaries.test.ts.
 */
import type { StatusTone } from "@/components/ui/StatusDot";
import type { DeviceStatusKey } from "@/lib/devices/present";
import type { StuckReason } from "@/lib/devices/admin";

export function printerTone(status: string): StatusTone {
  switch (status) {
    case "online":
      return "success";
    case "error":
      return "danger";
    case "unknown":
      return "warning";
    default:
      return "neutral";
  }
}

const PRINTER_WORD: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  error: "Has a problem",
  unknown: "Not reported yet",
};

export function printerStatusWord(status: string): string {
  return PRINTER_WORD[status] ?? "Not reported yet";
}

/** A printer card opens by itself only when the printer reports an error. */
export function printerNeedsAttention(status: string): boolean {
  return status === "error";
}

export function queueCountLabel(n: number): string {
  if (n <= 0) return "No queues yet";
  return n === 1 ? "1 queue" : `${n} queues`;
}

export function printerSummary(p: { status: string; queues: number; serverName: string | null }): string {
  const queues = p.queues <= 0 ? "no queues yet" : queueCountLabel(p.queues);
  const parts = [printerStatusWord(p.status), queues];
  if (p.serverName) parts.push(`server ${p.serverName}`);
  return parts.join(", ");
}

export function agentMachineSummary(a: { os_version: string | null; hostname: string | null }): string {
  const parts = [a.os_version, a.hostname].filter((v): v is string => !!v);
  return parts.length ? parts.join(", ") : "Not reported yet";
}

export function agentVersionSummary(v: { reported: string | null; state: string }): string {
  if (!v.reported) return "Not reported yet";
  if (v.state === "outdated") return `${v.reported}, update available`;
  return `${v.reported}, up to date`;
}

export function agentQueuesSummary(n: number): string {
  return queueCountLabel(n);
}

const COMMAND_NAME: Record<string, string> = {
  CHECK_FOR_UPDATE: "Update server",
  RESTART_SERVICE: "Restart service",
  CLEAR_TEMP_FILES: "Clear temp files",
  REFRESH_PRINTER_STATUS: "Refresh printer status",
  RESTART_PRINT_QUEUE: "Restart queue",
};

function commandName(raw: string): string {
  if (COMMAND_NAME[raw]) return COMMAND_NAME[raw];
  const s = raw.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const COMMAND_STATE: Record<string, string> = {
  completed: "done",
  failed: "failed",
  pending: "waiting",
  acknowledged: "waiting",
};

/** Commands are expected newest first. */
export function agentCommandsSummary(commands: Array<{ command: string; status: string }>): string {
  const last = commands[0];
  if (!last) return "Nothing sent yet";
  return `Last: ${commandName(last.command)}, ${COMMAND_STATE[last.status] ?? last.status}`;
}

/** The dot colour for a user device: open problems first, then "stuck", then its stage. */
export function deviceTone(d: { statusKey: DeviceStatusKey; openIssues: number; stuck: StuckReason | null }): StatusTone {
  if (d.openIssues > 0) return "danger";
  if (d.stuck) return "warning";
  if (d.statusKey === "printed") return "success";
  return "neutral";
}
