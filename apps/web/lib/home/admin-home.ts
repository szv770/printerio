import { routes } from "@/lib/routes";
import { friendlyFailureMessage } from "@/lib/job-failure";
import { isStale, jobSizeText, oldestWaitedText, timeAgo } from "./format";

/**
 * Pure logic behind the admin home: turns plain rows into the ordered
 * "Needs attention" list and the "Right now" strip. No queries, no JSX.
 */

export type Severity = "danger" | "warning";

export interface AttentionItem {
  id: "agents" | "printers" | "failed" | "approvals" | "held" | "waiting" | "devices";
  severity: Severity;
  title: string;
  note: string;
  href: string;
  action: string;
}

export interface AgentRow {
  id: string;
  name: string;
  lastSeenAt: string | null;
}
export interface PrinterRow {
  id: string;
  name: string;
  status: string;
}

export interface AttentionInput {
  now: Date;
  pendingApprovals: { count: number; oldestCreatedAt: string | null };
  /** Failed in the last 7 days: total count and the latest few. */
  failed: { count: number; recent: { name: string; errorMessage: string | null }[] };
  agents: AgentRow[];
  printers: PrinterRow[];
  heldCount: number;
  /** Queued jobs the printer could not take yet ("waiting for the printer"). They are NOT failures. */
  waitingForPrinter?: { count: number };
  /** null when the viewer cannot see devices (approvers). */
  stuckDevices: number | null;
}

export function adminAllClearText(): string {
  return "All clear. Nothing needs you right now.";
}

const isPrinterProblem = (status: string) => status === "offline" || status === "error";

function joinNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const { now } = input;
  const items: AttentionItem[] = [];

  // Danger first. A print server that never connected is a setup step, not an alert.
  const offlineAgents = input.agents.filter((a) => a.lastSeenAt && isStale(a.lastSeenAt, now));
  const firstOffline = offlineAgents[0];
  if (firstOffline) {
    items.push({
      id: "agents",
      severity: "danger",
      title: offlineAgents.length === 1 ? "Print server is offline" : `${offlineAgents.length} print servers are offline`,
      note:
        offlineAgents.length === 1
          ? `${firstOffline.name} was last seen ${timeAgo(firstOffline.lastSeenAt, now)}.`
          : joinNames(offlineAgents.map((a) => a.name)),
      href: routes.adminAgents,
      action: "Check",
    });
  }

  const badPrinters = input.printers.filter((p) => isPrinterProblem(p.status));
  const onlyBad = badPrinters[0];
  if (badPrinters.length === 1 && onlyBad) {
    const p = onlyBad;
    items.push({
      id: "printers",
      severity: "danger",
      title: p.status === "offline" ? `${p.name} printer is offline` : `${p.name} printer has a problem`,
      note: "Jobs for it will wait until it is back.",
      href: routes.adminPrinters,
      action: "Check",
    });
  } else if (badPrinters.length > 1) {
    items.push({
      id: "printers",
      severity: "danger",
      title: `${badPrinters.length} printers need a look`,
      note: joinNames(badPrinters.map((p) => p.name)),
      href: routes.adminPrinters,
      action: "Check",
    });
  }

  if (input.failed.count > 0) {
    const { count, recent } = input.failed;
    const note =
      count === 1 && recent[0]
        ? `${recent[0].name}: ${friendlyFailureMessage(recent[0].errorMessage)}`
        : joinNames(recent.map((r) => r.name));
    items.push({
      id: "failed",
      severity: "danger",
      title: `${count} ${count === 1 ? "print failed" : "prints failed"} this week`,
      note,
      href: `${routes.adminJobs}?status=failed`,
      action: "See why",
    });
  }

  const waitingCount = input.waitingForPrinter?.count ?? 0;
  if (waitingCount > 0) {
    items.push({
      id: "waiting",
      severity: "warning",
      title: waitingCount === 1 ? "1 job is waiting for the printer" : `${waitingCount} jobs are waiting for the printer`,
      note: "The printer is off, offline or not reachable. They print by themselves when it is back.",
      href: `${routes.adminJobs}?status=waiting`,
      action: "Look",
    });
  }

  if (input.pendingApprovals.count > 0) {
    const n = input.pendingApprovals.count;
    items.push({
      id: "approvals",
      severity: "warning",
      title: `${n} ${n === 1 ? "job" : "jobs"} waiting for approval`,
      note: oldestWaitedText(input.pendingApprovals.oldestCreatedAt, now),
      href: routes.adminApprovals,
      action: "Review",
    });
  }

  if (input.heldCount > 0) {
    const n = input.heldCount;
    items.push({
      id: "held",
      severity: "warning",
      title: `${n} ${n === 1 ? "job needs" : "jobs need"} a choice from their owner`,
      note: "They are on hold until the person picks how to print.",
      href: `${routes.adminJobs}?status=held`,
      action: "Look",
    });
  }

  if (input.stuckDevices && input.stuckDevices > 0) {
    const n = input.stuckDevices;
    items.push({
      id: "devices",
      severity: "warning",
      title: `${n} ${n === 1 ? "device is" : "devices are"} connected but stuck`,
      note: "They connected but nothing has printed from them yet.",
      href: routes.adminDevices,
      action: "Help",
    });
  }

  return items;
}

export interface ActiveJobRow {
  id: string;
  jobNumber: string;
  printerId: string | null;
  status: string;
  pages: number;
  copies: number;
}

export interface RightNowInput {
  now: Date;
  agents: AgentRow[];
  printers: PrinterRow[];
  activeJobs: ActiveJobRow[];
}

export type RightNowTone = "live" | "success" | "danger" | "neutral";
export interface RightNowRow {
  key: string;
  kind: "printer" | "agent" | "job";
  name: string;
  detail: string;
  tone: RightNowTone;
  word: string;
}

function jobDetail(j: ActiveJobRow): string {
  const verb = j.status === "printing" || j.status === "submitted_to_spooler" ? "Printing" : "Sent to printer";
  // Nothing in the system records how many pages have physically come out, so
  // we show the size of the job rather than an invented "page 5 of 12".
  return [`${verb} ${j.jobNumber}`, jobSizeText(j.pages, j.copies)].filter(Boolean).join(" · ");
}

export function buildRightNow(input: RightNowInput): RightNowRow[] {
  const rows: RightNowRow[] = [];
  const byPrinter = new Map<string, ActiveJobRow>();
  const unassigned: ActiveJobRow[] = [];
  for (const j of input.activeJobs) {
    if (j.printerId && input.printers.some((p) => p.id === j.printerId)) {
      if (!byPrinter.has(j.printerId)) byPrinter.set(j.printerId, j);
    } else unassigned.push(j);
  }

  for (const p of input.printers) {
    const job = byPrinter.get(p.id);
    if (p.status === "offline") rows.push({ key: p.id, kind: "printer", name: p.name, detail: "Not reachable", tone: "danger", word: "Offline" });
    else if (p.status === "error") rows.push({ key: p.id, kind: "printer", name: p.name, detail: "Reported a problem", tone: "danger", word: "Problem" });
    else if (job) rows.push({ key: p.id, kind: "printer", name: p.name, detail: jobDetail(job), tone: "live", word: "Busy" });
    else if (p.status === "online") rows.push({ key: p.id, kind: "printer", name: p.name, detail: "Nothing printing", tone: "success", word: "Ready" });
    else rows.push({ key: p.id, kind: "printer", name: p.name, detail: "Status not reported", tone: "neutral", word: "Unknown" });
  }

  for (const j of unassigned) {
    rows.push({ key: j.id, kind: "job", name: j.jobNumber, detail: jobDetail(j), tone: "live", word: "Busy" });
  }

  for (const a of input.agents) {
    if (!a.lastSeenAt) rows.push({ key: a.id, kind: "agent", name: a.name, detail: "Has not connected yet", tone: "neutral", word: "Offline" });
    else if (isStale(a.lastSeenAt, input.now))
      rows.push({ key: a.id, kind: "agent", name: a.name, detail: `Last seen ${timeAgo(a.lastSeenAt, input.now)}`, tone: "danger", word: "Offline" });
    else rows.push({ key: a.id, kind: "agent", name: a.name, detail: "Print server connected", tone: "success", word: "OK" });
  }
  return rows;
}
