"use client";

import { useActionState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Download,
  Globe,
  Monitor,
  Pause,
  Play,
  Printer as PrinterIcon,
  RefreshCw,
  Terminal,
} from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Badge, Button, Card, EmptyState, FormError } from "@/components/ui";
import type { AgentActivity, AgentVersionStatus, QueueUsage } from "@/lib/agent-detail";
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

interface QueueRow {
  id: string;
  label: string;
  windowsQueueName: string;
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

const PRINTER_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  online: "success",
  offline: "neutral",
  error: "danger",
  unknown: "warning",
};

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
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Cpu className="h-5 w-5 text-[var(--color-muted)]" />
        <h2 className="font-medium">Connection</h2>
        <Badge tone={connection.tone}>{connection.label}</Badge>
        {agent.status !== "active" && <Badge tone="neutral">{agent.status}</Badge>}
      </div>
      <p className="mb-4 text-sm text-[var(--color-muted)]">{connection.detail}</p>

      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <Clock className="h-3.5 w-3.5" /> Last synced
          </dt>
          <dd className="font-medium">{formatTimestamp(activity.lastSyncedAt)}</dd>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Its most recent check-in. Happens every few seconds while it&apos;s running, even when it&apos;s idle.
          </p>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <PrinterIcon className="h-3.5 w-3.5" /> Last print job
          </dt>
          <dd className="font-medium">{formatTimestamp(activity.lastJobActivityAt)}</dd>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            The last time this machine actually picked up and worked on a job — not just checked in.
          </p>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-[var(--color-muted)]">
            <Terminal className="h-3.5 w-3.5" /> Last command carried out
          </dt>
          <dd className="font-medium">{formatTimestamp(activity.lastCommandAt)}</dd>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            The last time it finished something requested from this page.
          </p>
        </div>
      </dl>
    </Card>
  );
}

/** Machine identity: what the Agent reports about the PC it runs on. */
function MachineCard({ agent }: { agent: Tables<"agents"> }) {
  const ipAddresses = agent.ip_addresses ?? [];
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Monitor className="h-5 w-5 text-[var(--color-muted)]" />
        <h2 className="font-medium">This machine</h2>
      </div>
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
                  <code key={address} className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">
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
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Reported by the Agent itself each time it checks in. It&apos;s shown here so you can tell which physical
        computer this is — nothing in Printio uses it to decide what this Agent is allowed to do.
      </p>
    </Card>
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
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Download className="h-5 w-5 text-[var(--color-muted)]" />
        <h2 className="font-medium">Version</h2>
        <Badge tone={version.state === "outdated" ? "warning" : version.state === "unknown" ? "neutral" : "success"}>
          {version.reported ? `v${version.reported}` : "unknown"}
        </Badge>
        {version.state === "outdated" && <Badge tone="warning">update available</Badge>}
      </div>
      <p className="text-sm text-[var(--color-muted)]">{version.summary}</p>

      {canManage && (
        <div className="mt-4">
          {agent.is_git_checkout === null ? (
            <p className="text-sm text-[var(--color-muted)]">
              This Agent hasn&apos;t told us yet whether it can update itself — that information arrives with its next
              check-in (or after it&apos;s upgraded to a build that reports it). Until then, update it by running{" "}
              <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">setup-agent.bat</code> on that
              machine.
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
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Asks the Agent to pull the latest code into its own copy of the repository, reinstall its
                dependencies, and restart itself. It only does this if nothing has been changed locally — otherwise
                it reports back and changes nothing. The answer appears under &ldquo;Recent commands&rdquo; below
                within a minute or so.
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              This Agent can&apos;t update itself: it isn&apos;t running from a git clone (most likely it was
              extracted from a downloaded ZIP). To update it, run{" "}
              <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">setup-agent.bat</code> on that
              machine — see docs/agent-install.md.
            </p>
          )}
          <FormError message={state.error} />
        </div>
      )}
    </Card>
  );
}

/** The freeze switch. Enforced in the cloud, not here - see pauseAgentAction. */
function PauseCard({ agent, pausedByLabel }: { agent: Tables<"agents">; pausedByLabel: string | null }) {
  const [pauseState, pauseAction, pausePending] = useActionState(pauseAgentAction, initialAgentActionState);
  const [resumeState, resumeAction, resumePending] = useActionState(resumeAgentAction, initialAgentActionState);

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        {agent.paused ? (
          <Pause className="h-5 w-5 text-[var(--color-warning)]" />
        ) : (
          <Play className="h-5 w-5 text-[var(--color-muted)]" />
        )}
        <h2 className="font-medium">Taking new print jobs</h2>
        <Badge tone={agent.paused ? "warning" : "success"}>{agent.paused ? "Paused" : "Active"}</Badge>
      </div>

      {agent.paused ? (
        <>
          <p className="text-sm text-[var(--color-muted)]">
            This Agent is paused, so it won&apos;t pick up any new print jobs. Jobs stay queued and will print once
            it&apos;s resumed. Anything it had already started printing when you paused it finished normally.
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
          <p className="text-sm text-[var(--color-muted)]">
            Pause this Agent while you change toner, clear a jam, or work on the printer. It stays connected and
            visible here, but stops picking up new jobs — those simply wait in the queue instead of failing. This is
            enforced by Printio itself, not just shown here: a paused Agent is refused if it asks for work.
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
    </Card>
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
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <PrinterIcon className="h-5 w-5 text-[var(--color-muted)]" />
        <h2 className="font-medium">Print queues on this machine</h2>
        <Badge tone="neutral">{queues.length}</Badge>
      </div>

      {queues.length === 0 ? (
        <EmptyState message="No print queues are mapped to this Agent yet." icon={PrinterIcon} />
      ) : (
        <ul className="flex flex-col gap-3">
          {queues.map((queue) => (
            <QueueRowItem key={queue.id} agent={agent} queue={queue} canManage={canManage} />
          ))}
        </ul>
      )}
    </Card>
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

  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {queue.printerName} — {queue.label}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            Windows queue <code className="rounded bg-gray-100 px-1 py-0.5 font-mono">{queue.windowsQueueName}</code>
          </p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {queue.usage.totalJobs === 0
              ? "No print jobs have ever been sent to this queue."
              : `${queue.usage.totalJobs} job${queue.usage.totalJobs === 1 ? "" : "s"} sent (${queue.usage.printedJobs} reached the printer) • last used ${formatTimestamp(queue.usage.lastUsedAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge tone={agent.paused ? "warning" : (PRINTER_STATUS_TONE[queue.printerStatus] ?? "neutral")}>
            {agent.paused ? "Paused by admin" : queue.printerStatus}
          </Badge>
          {canManage && (
            <form action={action}>
              <input type="hidden" name="agentId" value={agent.id} />
              <input type="hidden" name="printerId" value={queue.printerId} />
              <input type="hidden" name="printerProfileId" value={queue.id} />
              <Button type="submit" variant="outline" size="sm" pending={pending} pendingLabel="…">
                Restart queue
              </Button>
            </form>
          )}
        </div>
      </div>
      <FormError message={state.error} />
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
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Terminal className="h-5 w-5 text-[var(--color-muted)]" />
        <h2 className="font-medium">Maintenance</h2>
      </div>
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Each of these sends one specific, pre-defined instruction to this Agent — Printio can never send a machine an
        arbitrary command. The Agent picks it up on its next check-in (within about 15 seconds) and reports the
        outcome under &ldquo;Recent commands&rdquo; below.
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
            Restart the Agent
          </Button>
        </form>
        <form action={clearAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <Button type="submit" variant="outline" size="sm" pending={clearPending} pendingLabel="…">
            Clear temporary files
          </Button>
        </form>
      </div>
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        &ldquo;Restart queue&rdquo; (above, per queue) restarts the Windows Print Spooler service on that machine,
        which clears a stuck queue — note it affects every printer queue on that computer, not just the one you
        clicked.
      </p>
      <FormError message={refreshState.error ?? restartState.error ?? clearState.error} />
    </Card>
  );
}

/** Proof that the buttons above are real: what was asked, and what the machine
 *  answered. Without this, every remote command is fire-and-forget. */
function CommandHistoryCard({ commands }: { commands: CommandRow[] }) {
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Terminal className="h-5 w-5 text-[var(--color-muted)]" />
        <h2 className="font-medium">Recent commands</h2>
      </div>
      {commands.length === 0 ? (
        <EmptyState message="Nothing has been sent to this Agent yet." icon={Terminal} />
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {commands.map((command) => {
            const message = commandResultMessage(command.result);
            return (
              <li key={command.id} className="rounded-lg border border-[var(--color-border)] p-3">
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
                    Waiting for the Agent to pick this up — it will if it&apos;s online.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
