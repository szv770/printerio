"use client";

import { useActionState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Download,
  FileCheck2,
  Globe,
  Monitor,
  Pause,
  Play,
  Printer as PrinterIcon,
  RefreshCw,
  Terminal,
  Wrench,
} from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Badge, Button, Collapsible, EmptyState, FormError, StatusDot } from "@/components/ui";
import {
  agentCommandsSummary,
  agentMachineSummary,
  agentQueuesSummary,
  agentVersionSummary,
  printerStatusWord,
  printerTone,
} from "@/lib/admin/summaries";
import type { AgentActivity, AgentVersionStatus, QueueUsage } from "@/lib/agent-detail";
// "Send test print" is deliberately the SAME server action the Printers page
// binds its own button to, imported rather than re-implemented here: one
// authorization check, one pipeline, one place to change.
import { sendTestPrintAction, type PrinterActionState } from "../../printers/actions";
import {
  checkAgentForUpdateAction,
  clearAgentTempFilesAction,
  pauseAgentAction,
  refreshAgentPrinterStatusAction,
  restartAgentPrintQueueAction,
  restartAgentServiceAction,
  resumeAgentAction,
  type AgentActionState,
} from "../actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action - the
// same placement PrintersPanel uses for the identical reason.
const initialAgentActionState: AgentActionState = {};
const initialPrinterActionState: PrinterActionState = {};

interface QueueRow {
  id: string;
  label: string;
  windowsQueueName: string | null;
  /** "host:port" for direct-to-printer profiles. */
  rawTarget?: string | null;
  printerId: string;
  printerName: string;
  printerStatus: string;
  printerStatusAt: string | null;
  usage: QueueUsage;
}

interface CommandRow {
  id: string;
  command: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
}

const COMMAND_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  completed: "success",
  failed: "danger",
  pending: "warning",
  acknowledged: "warning",
};

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

/** Pulls the Agent's own plain-English answer out of a remote_commands.result
 *  blob, when it left one (CHECK_FOR_UPDATE always does). Defensive by design:
 *  this is a jsonb column written by the Agent, so it is treated as unknown
 *  data, never as a trusted shape. */
function commandResultMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const message = (result as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}

export function AgentDetail({
  agent,
  connection,
  version,
  activity,
  pausedByLabel,
  queues,
  recentCommands,
  canManage,
}: {
  agent: Tables<"agents">;
  connection: { label: string; tone: "success" | "warning" | "danger" | "neutral"; detail: string };
  version: AgentVersionStatus;
  activity: AgentActivity;
  pausedByLabel: string | null;
  queues: QueueRow[];
  recentCommands: CommandRow[];
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ConnectionCard agent={agent} connection={connection} activity={activity} />
      <MachineCard agent={agent} />
      <VersionCard agent={agent} version={version} canManage={canManage} />
      {canManage && <PauseCard agent={agent} pausedByLabel={pausedByLabel} />}
      <QueuesCard agent={agent} queues={queues} canManage={canManage} />
      {canManage && <MaintenanceCard agent={agent} />}
      <CommandHistoryCard commands={recentCommands} />
    </div>
  );
}

/** "Last synced" vs what the machine has actually been doing - three
 *  timestamps that are genuinely different questions (see deriveAgentActivity
 *  for why each one earns its place instead of being one "last active" line). */
function ConnectionCard({
  agent,
  connection,
  activity,
}: {
  agent: Tables<"agents">;
  connection: { label: string; tone: "success" | "warning" | "danger" | "neutral"; detail: string };
  activity: AgentActivity;
}) {
  return (
    <Collapsible
      id="connection"
      title="Connection"
      icon={<Cpu className="h-4 w-4" />}
      summary={connection.label}
      badge={<StatusDot tone={connection.tone}>{connection.label}</StatusDot>}
      defaultOpen
    >
      {agent.status !== "active" && (
        <p className="mb-4">
          <Badge tone="neutral">{agent.status}</Badge>
        </p>
      )}

      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <Clock className="h-3.5 w-3.5" /> Last synced
          </dt>
          <dd className="font-medium">{formatTimestamp(activity.lastSyncedAt)}</dd>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Its latest check-in. It checks in every few seconds while running, even when idle.
          </p>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <PrinterIcon className="h-3.5 w-3.5" /> Last print job
          </dt>
          <dd className="font-medium">{formatTimestamp(activity.lastJobActivityAt)}</dd>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            The last time it picked up a job, not just checked in.
          </p>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <Terminal className="h-3.5 w-3.5" /> Last request done
          </dt>
          <dd className="font-medium">{formatTimestamp(activity.lastCommandAt)}</dd>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            The last time it finished something you asked it to do here.
          </p>
        </div>
      </dl>
    </Collapsible>
  );
}

/** Machine identity: what the Agent reports about the PC it runs on. */
function MachineCard({ agent }: { agent: Tables<"agents"> }) {
  const ipAddresses = agent.ip_addresses ?? [];
  return (
    <Collapsible id="machine" title="This computer" icon={<Monitor className="h-4 w-4" />} summary={agentMachineSummary(agent)}>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[var(--color-muted)]">Computer name</dt>
          <dd className="font-medium">{agent.hostname ?? "Not reported yet"}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">Operating system</dt>
          <dd className="font-medium">{agent.os_version ?? "Not reported yet"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <Globe className="h-3.5 w-3.5" /> Network addresses
          </dt>
          <dd className="font-medium">
            {ipAddresses.length > 0 ? (
              <span className="flex flex-wrap gap-2">
                {ipAddresses.map((address) => (
                  <code key={address} className="rounded bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-xs">
                    {address}
                  </code>
                ))}
              </span>
            ) : (
              "Not reported yet"
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[13px] text-[var(--color-muted)]">
        The print server reports this itself, so you can tell which computer it is. Printio does not use it for anything else.
      </p>
    </Collapsible>
  );
}

/** Version + the compare-target, and the honest limits of remote updating. */
function VersionCard({
  agent,
  version,
  canManage,
}: {
  agent: Tables<"agents">;
  version: AgentVersionStatus;
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(checkAgentForUpdateAction, initialAgentActionState);
  const canSelfUpdate = agent.is_git_checkout === true;

  return (
    <Collapsible
      id="version"
      title="Version"
      icon={<Download className="h-4 w-4" />}
      summary={agentVersionSummary(version)}
      badge={version.state === "outdated" ? <Badge tone="warning">Update available</Badge> : undefined}
      forceOpen={!!state.error}
    >
      <p className="text-sm text-[var(--color-text-2)]">{version.summary}</p>

      {canManage && (
        <div className="mt-4">
          {agent.is_git_checkout === null ? (
            <p className="text-sm text-[var(--color-muted)]">
              It has not said yet whether it can update itself. That arrives with its next check-in. Until then, update it by
              running <code className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-xs">setup-agent.bat</code> on that computer.
            </p>
          ) : canSelfUpdate ? (
            <>
              <form action={action}>
                <input type="hidden" name="agentId" value={agent.id} />
                <Button type="submit" variant="outline" size="sm" pending={pending} pendingLabel="Requesting...">
                  <span className="flex items-center gap-1">
                    <RefreshCw className="h-3.5 w-3.5" /> Check for updates
                  </span>
                </Button>
              </form>
              <p className="mt-2 text-[13px] text-[var(--color-muted)]">
                Asks the print server to update itself and restart. If anything was changed on that computer by hand, it
                tells you and changes nothing. The answer shows under &ldquo;Recent requests&rdquo; within a minute.
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              This print server cannot update itself. To update it, run{" "}
              <code className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-xs">setup-agent.bat</code> on that computer.
            </p>
          )}
          <FormError message={state.error} />
        </div>
      )}
    </Collapsible>
  );
}

/** The freeze switch. Enforced in the cloud, not here - see pauseAgentAction. */
function PauseCard({ agent, pausedByLabel }: { agent: Tables<"agents">; pausedByLabel: string | null }) {
  const [pauseState, pauseAction, pausePending] = useActionState(pauseAgentAction, initialAgentActionState);
  const [resumeState, resumeAction, resumePending] = useActionState(resumeAgentAction, initialAgentActionState);

  return (
    <Collapsible
      id="taking-jobs"
      title="Taking new jobs"
      icon={agent.paused ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      summary={agent.paused ? "No, paused" : "Yes"}
      badge={agent.paused ? <Badge tone="warning">Paused</Badge> : undefined}
      forceOpen={!!(pauseState.error || resumeState.error)}
    >

      {agent.paused ? (
        <>
          <p className="text-sm text-[var(--color-text-2)]">
            This print server is paused, so it will not pick up new jobs. They wait in line and print once you resume it.
            {pausedByLabel ? ` Paused by ${pausedByLabel}` : " Paused"}
            {agent.paused_at ? ` on ${new Date(agent.paused_at).toLocaleString()}.` : "."}
          </p>
          <form action={resumeAction} className="mt-3">
            <input type="hidden" name="agentId" value={agent.id} />
            <Button type="submit" variant="primary" size="sm" pending={resumePending} pendingLabel="Resuming...">
              <span className="flex items-center gap-1">
                <Play className="h-3.5 w-3.5" /> Resume taking print jobs
              </span>
            </Button>
          </form>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--color-text-2)]">
            Pause it while you change toner or clear a jam. New jobs wait in line instead of failing.
          </p>
          <form action={pauseAction} className="mt-3">
            <input type="hidden" name="agentId" value={agent.id} />
            <Button type="submit" variant="outline" size="sm" pending={pausePending} pendingLabel="Pausing...">
              <span className="flex items-center gap-1">
                <Pause className="h-3.5 w-3.5" /> Pause new print jobs
              </span>
            </Button>
          </form>
        </>
      )}
      <FormError message={pauseState.error ?? resumeState.error} />
    </Collapsible>
  );
}

/** Which queues this Agent actually drives, and whether they're being used. */
function QueuesCard({
  agent,
  queues,
  canManage,
}: {
  agent: Tables<"agents">;
  queues: QueueRow[];
  canManage: boolean;
}) {
  return (
    <Collapsible
      id="queues"
      title="Print queues"
      icon={<PrinterIcon className="h-4 w-4" />}
      summary={agentQueuesSummary(queues.length)}
      badge={<Badge tone="neutral">{queues.length}</Badge>}
    >

      {queues.length === 0 ? (
        <EmptyState message="No print queues use this print server yet." icon={PrinterIcon} />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {queues.map((queue) => (
              <QueueRowItem key={queue.id} agent={agent} queue={queue} canManage={canManage} />
            ))}
          </ul>
          {canManage && (
            <p className="mt-3 text-[13px] text-[var(--color-muted)]">
              &ldquo;Send test print&rdquo; sends one real page to that queue, the way a user&apos;s job goes, and opens its status
              page. It skips print rules, approval and limits, and is left out of usage reports. Job counts above include it.
            </p>
          )}
        </>
      )}
    </Collapsible>
  );
}

function QueueRowItem({
  agent,
  queue,
  canManage,
}: {
  agent: Tables<"agents">;
  queue: QueueRow;
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(restartAgentPrintQueueAction, initialAgentActionState);
  const [testState, testAction, testPending] = useActionState(sendTestPrintAction, initialPrinterActionState);

  return (
    <li className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {queue.printerName} — {queue.label}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            {queue.rawTarget ? "Straight to" : "Windows queue"}{" "}
            <code className="rounded bg-[var(--color-surface)] px-1 py-0.5 font-mono">{queue.rawTarget ?? queue.windowsQueueName}</code>
          </p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {queue.usage.totalJobs === 0
              ? "No print jobs have ever been sent to this queue."
              : `${queue.usage.totalJobs} job${queue.usage.totalJobs === 1 ? "" : "s"} sent (${queue.usage.printedJobs} reached the printer) • last used ${formatTimestamp(queue.usage.lastUsedAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <StatusDot tone={agent.paused ? "warning" : printerTone(queue.printerStatus)}>
            {agent.paused ? "Paused" : printerStatusWord(queue.printerStatus)}
          </StatusDot>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {/* One real page through the real pipeline to THIS queue - the
               *  fastest way to answer "does this machine actually print?"
               *  without waiting for someone to submit a job. */}
              <form action={testAction}>
                <input type="hidden" name="printerProfileId" value={queue.id} />
                <Button type="submit" variant="outline" size="sm" pending={testPending} pendingLabel="Sending…">
                  <span className="flex items-center gap-1">
                    <FileCheck2 className="h-3.5 w-3.5" /> Send test print
                  </span>
                </Button>
              </form>
              <form action={action}>
                <input type="hidden" name="agentId" value={agent.id} />
                <input type="hidden" name="printerId" value={queue.printerId} />
                <input type="hidden" name="printerProfileId" value={queue.id} />
                <Button type="submit" variant="outline" size="sm" pending={pending} pendingLabel="…">
                  Restart queue
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
      {agent.paused && canManage && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          This print server is paused, so a test print waits until you resume it.
        </p>
      )}
      <FormError message={testState.error ?? state.error} />
    </li>
  );
}

/** Agent-wide maintenance: the existing fixed remote commands, gathered in one
 *  place with an explanation of what each actually does on the Windows side. */
function MaintenanceCard({ agent }: { agent: Tables<"agents"> }) {
  const [refreshState, refreshAction, refreshPending] = useActionState(
    refreshAgentPrinterStatusAction,
    initialAgentActionState,
  );
  const [restartState, restartAction, restartPending] = useActionState(
    restartAgentServiceAction,
    initialAgentActionState,
  );
  const [clearState, clearAction, clearPending] = useActionState(clearAgentTempFilesAction, initialAgentActionState);

  return (
    <Collapsible
      id="maintenance"
      title="Maintenance"
      icon={<Wrench className="h-4 w-4" />}
      summary="Refresh, restart, clear temp files"
      forceOpen={!!(refreshState.error || restartState.error || clearState.error)}
    >
      <p className="mb-3 text-sm text-[var(--color-text-2)]">
        Each button sends one fixed request. The print server picks it up within about 15 seconds and reports back under
        &ldquo;Recent requests&rdquo;.
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={refreshAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <Button type="submit" variant="outline" size="sm" pending={refreshPending} pendingLabel="…">
            Refresh printer status
          </Button>
        </form>
        <form action={restartAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <Button type="submit" variant="outline" size="sm" pending={restartPending} pendingLabel="…">
            Restart the print server
          </Button>
        </form>
        <form action={clearAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <Button type="submit" variant="outline" size="sm" pending={clearPending} pendingLabel="…">
            Clear temporary files
          </Button>
        </form>
      </div>
      <p className="mt-3 text-[13px] text-[var(--color-muted)]">
        &ldquo;Restart queue&rdquo; on a queue restarts Windows printing on that computer. It clears a stuck queue but affects every
        printer queue on it.
      </p>
      <FormError message={refreshState.error ?? restartState.error ?? clearState.error} />
    </Collapsible>
  );
}

/** Proof that the buttons above are real: what was asked, and what the machine
 *  answered. Without this, every remote command is fire-and-forget. */
function CommandHistoryCard({ commands }: { commands: CommandRow[] }) {
  return (
    <Collapsible
      id="requests"
      title="Recent requests"
      icon={<Terminal className="h-4 w-4" />}
      summary={agentCommandsSummary(commands)}
    >
      {commands.length === 0 ? (
        <EmptyState message="Nothing has been sent to this print server yet." icon={Terminal} />
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {commands.map((command) => {
            const message = commandResultMessage(command.result);
            return (
              <li key={command.id} className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  {command.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
                  ) : command.status === "failed" ? (
                    <AlertTriangle className="h-4 w-4 text-[var(--color-danger)]" />
                  ) : (
                    <Clock className="h-4 w-4 text-[var(--color-muted)]" />
                  )}
                  <code className="font-mono text-xs">{command.command}</code>
                  <Badge tone={COMMAND_STATUS_TONE[command.status] ?? "neutral"}>{command.status}</Badge>
                  <span className="text-xs text-[var(--color-muted)]">
                    sent {formatTimestamp(command.createdAt)}
                    {command.completedAt ? ` • answered ${formatTimestamp(command.completedAt)}` : ""}
                  </span>
                </div>
                {message && <p className="mt-2 text-sm text-[var(--color-muted)]">{message}</p>}
                {command.status === "pending" && (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    Waiting for the print server to pick this up. It will if it is online.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Collapsible>
  );
}
