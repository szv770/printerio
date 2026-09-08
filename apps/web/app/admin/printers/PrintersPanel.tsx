"use client";

import { useActionState, useState } from "react";
import { FileCheck2, Pause, Printer as PrinterIcon, Wifi, WifiOff } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, Select, FieldLabel, FormError, EmptyState, Badge, Card } from "@/components/ui";
import {
  PRINTER_PROFILE_ICON_KEYS,
  PRINTER_PROFILE_ICON_LABELS,
  PRINTER_PROFILE_ICON_COMPONENTS,
  type PrinterProfileIconKey,
} from "@/lib/printer-profile-icons";
import {
  createPrinterAction,
  createPrinterProfileAction,
  refreshPrinterStatusAction,
  restartPrintQueueAction,
  sendTestPrintAction,
  type PrinterActionState,
} from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialPrinterActionState: PrinterActionState = {};

type Printer = Tables<"printers">;
type PrinterProfile = Tables<"printer_profiles">;
interface AgentInfo {
  id: string;
  name: string;
  last_seen_at: string | null;
  /** agents.paused - a deliberately held Agent is connected and healthy but
   *  taking no new jobs, which must not read as "offline"/broken here. */
  paused: boolean;
}

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  online: "success",
  offline: "neutral",
  error: "danger",
  unknown: "warning",
};

const AGENT_ONLINE_WINDOW_MS = 5 * 60_000; // same 5-min-without-a-heartbeat rule as admin/page.tsx and AgentsPanel

export function PrintersPanel({
  printers,
  profiles,
  agents,
  canManage,
  defaultBookletBindingSide,
}: {
  printers: Printer[];
  profiles: PrinterProfile[];
  agents: AgentInfo[];
  canManage: boolean;
  /** organization_settings.default_booklet_binding_side - prefills a new
   *  booklet-capable profile's binding side (see NewProfileForm) rather than
   *  always defaulting to "left". */
  defaultBookletBindingSide: "left" | "right";
}) {
  const [createPrinterState, createPrinterAct, creatingPrinter] = useActionState(createPrinterAction, initialPrinterActionState);
  const [showNewProfileFor, setShowNewProfileFor] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6" data-tour="admin-printers-panel">
      {canManage && (
        <Card>
          <form action={createPrinterAct} className="flex flex-wrap items-end gap-3">
            <div>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required placeholder="Main Office Kyocera" />
            </div>
            <div>
              <FieldLabel htmlFor="vendor">Vendor</FieldLabel>
              <Input id="vendor" name="vendor" placeholder="Kyocera" />
            </div>
            <div>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              <Input id="model" name="model" placeholder="TASKalfa MZ8500i" />
            </div>
            <div>
              <FieldLabel htmlFor="location">Location</FieldLabel>
              <Input id="location" name="location" placeholder="Front office" />
            </div>
            <Button type="submit" size="sm" pending={creatingPrinter} pendingLabel="Adding...">
              Add printer
            </Button>
            <FormError message={createPrinterState.error} />
          </form>
        </Card>
      )}

      <ul className="flex flex-col gap-4">
        {printers.map((printer) => {
          const printerProfiles = profiles.filter((p) => p.printer_id === printer.id);
          return (
            <li key={printer.id}>
              <Card>
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    {/* Leading printer icon, tinted by status - a list of many
                     *  printers scans faster with a per-row visual identity
                     *  than a plain name + text badge alone. */}
                    <PrinterIcon
                      className={`mt-0.5 h-6 w-6 shrink-0 ${
                        printer.status === "online"
                          ? "text-[var(--color-success)]"
                          : printer.status === "error"
                            ? "text-[var(--color-danger)]"
                            : "text-[var(--color-muted)]"
                      }`}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{printer.name}</p>
                        <Badge tone={STATUS_TONE[printer.status] ?? "neutral"}>{printer.status}</Badge>
                      </div>
                      <p className="text-xs text-[var(--color-muted)]">
                        {printer.vendor} {printer.model} {printer.location ? `• ${printer.location}` : ""}
                        {printer.last_status_at && ` • last reported ${new Date(printer.last_status_at).toLocaleString()}`}
                      </p>
                    </div>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setShowNewProfileFor(showNewProfileFor === printer.id ? null : printer.id)}
                      className="text-xs font-medium text-[var(--color-primary)]"
                    >
                      + Add finishing profile
                    </button>
                  )}
                </div>

                <ul className="flex flex-col gap-1 text-sm">
                  {printerProfiles.map((p) => {
                    const owningAgent = agents.find((a) => a.id === p.agent_id);
                    const ProfileIcon =
                      p.icon_key && p.icon_key in PRINTER_PROFILE_ICON_COMPONENTS
                        ? PRINTER_PROFILE_ICON_COMPONENTS[p.icon_key as PrinterProfileIconKey]
                        : null;
                    return (
                      <li key={p.id} className="rounded bg-gray-50 px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-2">
                            {ProfileIcon && <ProfileIcon className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                            <span>
                              <span className="font-medium">{p.label}</span> ({p.key}) — queue <code>{p.windows_queue_name}</code>
                            </span>
                          </span>
                          {canManage && <ProfileRemoteActions printer={printer} profile={p} />}
                        </div>
                        {p.description && <p className="mt-1 text-xs text-[var(--color-text)]">{p.description}</p>}
                        <p className="mt-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                          <span>
                            Declared: {p.declared_paper_sizes.join(", ")} •{" "}
                            {Object.entries(p.declared_capabilities as Record<string, boolean>)
                              .filter(([, v]) => v)
                              .map(([k]) => k)
                              .join(", ") || "no special capabilities"}
                          </span>
                          {/* Diagnosing a printer error usually starts with "is its agent even
                           *  online" - shown inline so that doesn't require a separate trip to
                           *  /admin/agents. */}
                          {owningAgent && <AgentOnlineBadge agent={owningAgent} />}
                        </p>
                      </li>
                    );
                  })}
                  {printerProfiles.length === 0 && <p className="text-xs text-[var(--color-muted)]">No finishing profiles yet.</p>}
                </ul>

                {showNewProfileFor === printer.id && (
                  <NewProfileForm printerId={printer.id} agents={agents} defaultBookletBindingSide={defaultBookletBindingSide} />
                )}
              </Card>
            </li>
          );
        })}
        {printers.length === 0 && <EmptyState message="No printers yet." icon={PrinterIcon} />}
      </ul>

      <p className="text-xs text-[var(--color-muted)]">
        Capabilities and paper sizes above are administrator-declared, not verified against the physical device by
        Printio - see docs/printer-setup.md for how to actually configure a Windows queue&apos;s finishing defaults before
        declaring them here. Status only ever reflects what the Agent last reported at heartbeat time (docs/architecture.md
        sec 11) - it is not polled live. That is what &ldquo;Send test print&rdquo; is for: it puts one real page through
        the whole pipeline to that queue - same upload, same agent, same Windows queue as a student&apos;s job - and opens
        its status page so you can watch it. It skips print rules, approval and quota, and is excluded from usage reports.
      </p>
    </div>
  );
}

function AgentOnlineBadge({ agent }: { agent: AgentInfo }) {
  // Deliberately impure (Date.now()) - a snapshot at render time, not a value
  // that needs to stay referentially stable across re-renders. Same
  // rationale as admin/page.tsx's onlineCutoff and AgentsPanel's `online`.
  // eslint-disable-next-line react-hooks/purity
  const online = !!agent.last_seen_at && Date.now() - new Date(agent.last_seen_at).getTime() < AGENT_ONLINE_WINDOW_MS;
  // Paused outranks online/offline: this queue is intentionally held, which is
  // a different (and much less alarming) thing than a machine that has stopped
  // answering. See lib/agent-detail.ts's describeAgentConnection.
  if (agent.paused) {
    return (
      <Badge tone="warning">
        <span className="flex items-center gap-1">
          <Pause className="h-3.5 w-3.5" />
          Agent: {agent.name} • paused by admin
        </span>
      </Badge>
    );
  }
  return (
    <Badge tone={online ? "success" : "neutral"}>
      <span className="flex items-center gap-1">
        {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        Agent: {agent.name} • {online ? "online" : "offline"}
      </span>
    </Badge>
  );
}

/** "Refresh status"/"Restart queue" - issues a fixed, allow-listed remote
 *  command (docs/architecture.md sec 12) via a Server Action, never a raw
 *  fetch() from the client. "Send test print" sits alongside them because it
 *  answers the same question those two are usually pressed to answer ("is
 *  this queue actually working?") - but it is NOT a remote command: it
 *  creates a real print job on the real pipeline (see sendTestPrintAction)
 *  and navigates to that job's own status page. */
function ProfileRemoteActions({ printer, profile }: { printer: Printer; profile: PrinterProfile }) {
  const [refreshState, refreshAction, refreshPending] = useActionState(refreshPrinterStatusAction, initialPrinterActionState);
  const [restartState, restartAction, restartPending] = useActionState(restartPrintQueueAction, initialPrinterActionState);
  const [testState, testAction, testPending] = useActionState(sendTestPrintAction, initialPrinterActionState);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <form action={testAction}>
        <input type="hidden" name="printerProfileId" value={profile.id} />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          pending={testPending}
          pendingLabel="Sending…"
          title={`Print one test page on ${profile.label} to check this queue works end to end`}
        >
          <span className="flex items-center gap-1">
            <FileCheck2 className="h-3.5 w-3.5" />
            Send test print
          </span>
        </Button>
      </form>
      <form action={refreshAction}>
        <input type="hidden" name="agentId" value={profile.agent_id} />
        <input type="hidden" name="printerId" value={printer.id} />
        <Button type="submit" variant="outline" size="sm" pending={refreshPending} pendingLabel="…">
          Refresh status
        </Button>
      </form>
      <form action={restartAction}>
        <input type="hidden" name="agentId" value={profile.agent_id} />
        <input type="hidden" name="printerId" value={printer.id} />
        <input type="hidden" name="printerProfileId" value={profile.id} />
        <Button type="submit" variant="outline" size="sm" pending={restartPending} pendingLabel="…">
          Restart queue
        </Button>
      </form>
      <FormError message={testState.error ?? refreshState.error ?? restartState.error} />
    </div>
  );
}

function NewProfileForm({
  printerId,
  agents,
  defaultBookletBindingSide,
}: {
  printerId: string;
  agents: AgentInfo[];
  defaultBookletBindingSide: "left" | "right";
}) {
  const [state, formAction, pending] = useActionState(createPrinterProfileAction, initialPrinterActionState);
  const [iconKey, setIconKey] = useState<PrinterProfileIconKey | "">("");
  // Tracked separately from the other capability checkboxes (which stay
  // uncontrolled) purely so the binding-side field below can be shown/hidden
  // - it's meaningless for a non-booklet profile (see the column's own
  // comment in supabase/migrations/0017_*.sql).
  const [bookletChecked, setBookletChecked] = useState(false);

  return (
    <form action={formAction} className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm">
      <input type="hidden" name="printerId" value={printerId} />

      <p className="col-span-2 text-xs text-[var(--color-muted)]">
        One profile per Windows print queue. Set up the queue itself first (driver, finishing
        defaults) per <code>docs/printer-setup.md</code> - this form just registers a queue
        that already exists, it doesn&apos;t create one.
      </p>

      <div>
        <FieldLabel htmlFor="profileKey" hint="internal only, never shown to students">
          Key
        </FieldLabel>
        <Input id="profileKey" name="key" placeholder="booklet_saddle" required />
      </div>
      <div>
        <FieldLabel htmlFor="profileLabel" hint="what students see in the printer list">
          Label
        </FieldLabel>
        <Input id="profileLabel" name="label" placeholder="Booklet + Staple" required />
      </div>

      <div className="col-span-2">
        <FieldLabel htmlFor="profileDescription" hint="optional - what a user sees below the label when picking a profile">
          Description
        </FieldLabel>
        <Input
          id="profileDescription"
          name="description"
          placeholder="Black & white, double-sided - everyday documents"
        />
      </div>

      <div className="col-span-2">
        <FieldLabel hint="optional - shown next to the label wherever this profile is presented for selection">Icon</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setIconKey("")}
            className={`rounded-lg border px-2 py-1.5 text-xs ${
              iconKey === "" ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)]"
            }`}
          >
            None
          </button>
          {PRINTER_PROFILE_ICON_KEYS.map((key) => {
            const Icon = PRINTER_PROFILE_ICON_COMPONENTS[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => setIconKey(key)}
                className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${
                  iconKey === key ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {PRINTER_PROFILE_ICON_LABELS[key]}
              </button>
            );
          })}
        </div>
        <input type="hidden" name="iconKey" value={iconKey} />
      </div>

      <div className="col-span-2">
        <FieldLabel
          htmlFor="profileQueueName"
          hint="must exactly match the queue name in Windows on that machine - case-sensitive"
        >
          Windows queue name
        </FieldLabel>
        <Input id="profileQueueName" name="windowsQueueName" placeholder="Kyocera_Main_Booklet" required />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          On the Agent&apos;s Windows machine: Devices and Printers → right-click the queue →
          Printer properties → the name at the top. Copy it exactly - a typo here means the
          Agent can never find this queue.
        </p>
      </div>

      <div className="col-span-2">
        <FieldLabel htmlFor="profilePaperSizes" hint="comma-separated, matches what the driver's Printing Defaults offer">
          Paper sizes
        </FieldLabel>
        <Input id="profilePaperSizes" name="paperSizes" placeholder="letter,a4,11x17" />
      </div>

      <div className="col-span-2">
        <FieldLabel htmlFor="profileAgentId" hint="which registered Agent's machine this Windows queue lives on">
          Agent
        </FieldLabel>
        <Select id="profileAgentId" name="agentId" required>
          <option value="">Choose the agent that owns this queue…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="col-span-2">
        <FieldLabel hint="check only what this queue's own Printing Defaults actually do (docs/printer-setup.md §3) - Printio never programs these itself, it only ever picks which queue to use">
          Capabilities
        </FieldLabel>
        <div className="flex flex-wrap gap-3">
          {(["duplex", "color", "staple", "booklet", "punch"] as const).map((cap) =>
            cap === "booklet" ? (
              <label key={cap} className="flex items-center gap-1">
                <input type="checkbox" name={cap} checked={bookletChecked} onChange={(e) => setBookletChecked(e.target.checked)} /> {cap}
              </label>
            ) : (
              <label key={cap} className="flex items-center gap-1">
                <input type="checkbox" name={cap} /> {cap}
              </label>
            ),
          )}
        </div>
      </div>

      {bookletChecked && (
        <div className="col-span-2">
          <FieldLabel
            htmlFor="profileBindingSide"
            hint='matches the Kyocera KX driver’s own booklet "Left edge binding"/"Right edge binding" terminology (docs/printer-setup.md)'
          >
            Booklet binding side
          </FieldLabel>
          <Select id="profileBindingSide" name="bookletBindingSide" defaultValue={defaultBookletBindingSide}>
            <option value="left">Left edge binding (LTR reading)</option>
            <option value="right">Right edge binding (RTL reading, e.g. Hebrew)</option>
          </Select>
        </div>
      )}

      <label className="col-span-2 flex items-center gap-1">
        <input type="checkbox" name="isDefault" /> Pre-select this profile in the print form
      </label>

      <div className="col-span-2">
        <Button type="submit" size="sm" pending={pending} pendingLabel="Saving..." className="w-full">
          Save profile
        </Button>
      </div>
      <div className="col-span-2">
        <FormError message={state.error} />
      </div>
    </form>
  );
}
