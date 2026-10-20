"use client";

import { useActionState, useState } from "react";
import { FileCheck2, Pause, Pencil, Printer as PrinterIcon, Trash2, Wifi, WifiOff } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { isValidRawHost, parseRawPort } from "@/lib/printers/raw-target";
import { Button, Input, Select, FieldLabel, FormError, FormSuccess, EmptyState, Badge, Card } from "@/components/ui";
import {
  PRINTER_PROFILE_ICON_KEYS,
  PRINTER_PROFILE_ICON_LABELS,
  PRINTER_PROFILE_ICON_COMPONENTS,
  type PrinterProfileIconKey,
} from "@/lib/printer-profile-icons";
import {
  createPrinterAction,
  createPrinterProfileAction,
  deletePrinterProfileAction,
  refreshPrinterStatusAction,
  restartPrintQueueAction,
  sendTestPrintAction,
  updatePrinterAction,
  updatePrinterProfileAction,
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

const CAPABILITY_KEYS = ["duplex", "color", "staple", "booklet", "punch"] as const;
type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Reads printer_profiles.declared_capabilities (a jsonb column, so `unknown`
 *  as far as the generated types are concerned) into the fixed five booleans
 *  the form and the summary line both need. */
function readCapabilities(value: unknown): Record<CapabilityKey, boolean> {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    duplex: record.duplex === true,
    color: record.color === true,
    staple: record.staple === true,
    booklet: record.booklet === true,
    punch: record.punch === true,
  };
}

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

  return (
    <div className="flex flex-col gap-6" data-tour="admin-printers-panel">
      {canManage && (
        <Card>
          {/* Mobile-first: every field is full width and stacked, and only
           *  pairs up once there is room for it (sm:). The previous single
           *  flex row put four inputs plus a button side by side, which on a
           *  phone squeezed each one down to a few characters wide. */}
          <form action={createPrinterAct} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" pending={creatingPrinter} pendingLabel="Adding...">
                Add printer
              </Button>
            </div>
            <div className="sm:col-span-2">
              <FormError message={createPrinterState.error} />
            </div>
          </form>
        </Card>
      )}

      <ul className="flex flex-col gap-4">
        {printers.map((printer) => (
          <PrinterCard
            key={printer.id}
            printer={printer}
            profiles={profiles.filter((p) => p.printer_id === printer.id)}
            agents={agents}
            canManage={canManage}
            defaultBookletBindingSide={defaultBookletBindingSide}
          />
        ))}
        {printers.length === 0 && <EmptyState message="No printers yet." icon={PrinterIcon} />}
      </ul>

      <p className="text-xs text-[var(--color-muted)]">
        Capabilities and paper sizes above are administrator-declared, not verified against the physical device by
        Printio - see docs/printer-setup.md for how to actually configure a Windows queue&apos;s finishing defaults before
        declaring them here. Status only ever reflects what the Agent last reported at heartbeat time (docs/architecture.md
        sec 11) - it is not polled live. That is what &ldquo;Send test print&rdquo; is for: it puts one real page through
        the whole pipeline to that queue - same upload, same agent, same Windows queue as a user&apos;s job - and opens
        its status page so you can watch it. It skips print rules, approval and quota, and is excluded from usage reports.
      </p>
    </div>
  );
}

function PrinterCard({
  printer,
  profiles,
  agents,
  canManage,
  defaultBookletBindingSide,
}: {
  printer: Printer;
  profiles: PrinterProfile[];
  agents: AgentInfo[];
  canManage: boolean;
  defaultBookletBindingSide: "left" | "right";
}) {
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [editingPrinter, setEditingPrinter] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  return (
    <li>
      <Card>
        {/* flex-wrap, not a fixed two-column row: the name/meta block and the
         *  action links can't both fit on one line on a phone, and without
         *  wrapping the links used to be pushed off the card. */}
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-3">
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
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
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
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setEditingPrinter((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)]"
              >
                <Pencil className="h-3.5 w-3.5" />
                {editingPrinter ? "Close" : "Edit printer"}
              </button>
              <button
                type="button"
                onClick={() => setShowNewProfile((v) => !v)}
                className="text-xs font-medium text-[var(--color-primary)]"
              >
                + Add finishing profile
              </button>
            </div>
          )}
        </div>

        {editingPrinter && <EditPrinterForm printer={printer} />}

        <ul className="flex flex-col gap-1 text-sm">
          {profiles.map((p) => {
            const owningAgent = agents.find((a) => a.id === p.agent_id);
            const ProfileIcon =
              p.icon_key && p.icon_key in PRINTER_PROFILE_ICON_COMPONENTS
                ? PRINTER_PROFILE_ICON_COMPONENTS[p.icon_key as PrinterProfileIconKey]
                : null;
            const capabilities = readCapabilities(p.declared_capabilities);
            return (
              <li key={p.id} className="rounded bg-gray-50 px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="flex min-w-0 items-start gap-2">
                    {ProfileIcon && <ProfileIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{p.label}</span> ({p.key}) —{" "}
                      {p.output_mode === "raw" ? (
                        <>
                          direct to{" "}
                          <code>
                            {p.raw_host}:{p.raw_port}
                          </code>
                        </>
                      ) : (
                        <>
                          queue <code>{p.windows_queue_name}</code>
                        </>
                      )}
                    </span>
                  </span>
                  {canManage && (
                    <ProfileRowActions
                      printer={printer}
                      profile={p}
                      isEditing={editingProfileId === p.id}
                      onToggleEdit={() => setEditingProfileId(editingProfileId === p.id ? null : p.id)}
                    />
                  )}
                </div>
                {p.description && <p className="mt-1 text-xs text-[var(--color-text)]">{p.description}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                  <span>
                    Declared: {p.declared_paper_sizes.join(", ")} •{" "}
                    {CAPABILITY_KEYS.filter((k) => capabilities[k]).join(", ") || "no special capabilities"}
                  </span>
                  {/* Diagnosing a printer error usually starts with "is its agent even
                   *  online" - shown inline so that doesn't require a separate trip to
                   *  /admin/agents. */}
                  {owningAgent && <AgentOnlineBadge agent={owningAgent} />}
                </p>
                {canManage && editingProfileId === p.id && (
                  <EditProfileForm profile={p} agents={agents} onClose={() => setEditingProfileId(null)} />
                )}
              </li>
            );
          })}
          {profiles.length === 0 && <p className="text-xs text-[var(--color-muted)]">No finishing profiles yet.</p>}
        </ul>

        {canManage && showNewProfile && (
          <NewProfileForm printerId={printer.id} agents={agents} defaultBookletBindingSide={defaultBookletBindingSide} />
        )}
      </Card>
    </li>
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
 *  and navigates to that job's own status page. Edit/Delete act on the
 *  profile row itself rather than on the machine. */
function ProfileRowActions({
  printer,
  profile,
  isEditing,
  onToggleEdit,
}: {
  printer: Printer;
  profile: PrinterProfile;
  isEditing: boolean;
  onToggleEdit: () => void;
}) {
  const [refreshState, refreshAction, refreshPending] = useActionState(refreshPrinterStatusAction, initialPrinterActionState);
  const [restartState, restartAction, restartPending] = useActionState(restartPrintQueueAction, initialPrinterActionState);
  const [testState, testAction, testPending] = useActionState(sendTestPrintAction, initialPrinterActionState);
  const [deleteState, deleteAction, deletePending] = useActionState(deletePrinterProfileAction, initialPrinterActionState);

  return (
    // Wraps rather than staying on one line: five small buttons never fit on
    // a phone, and `shrink-0` on a non-wrapping row made them overflow the
    // card entirely instead of moving onto a second line.
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onToggleEdit}
        title={`Edit ${profile.label} - its label, queue name, agent, declared capabilities`}
      >
        <span className="flex items-center gap-1">
          <Pencil className="h-3.5 w-3.5" />
          {isEditing ? "Close" : "Edit"}
        </span>
      </Button>
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
      <form
        action={deleteAction}
        onSubmit={(e) => {
          if (!confirm(`Delete the "${profile.label}" profile? Users will no longer be able to pick it.`)) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="printerProfileId" value={profile.id} />
        <Button type="submit" variant="outline-danger" size="sm" pending={deletePending} pendingLabel="…">
          <span className="flex items-center gap-1">
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </span>
        </Button>
      </form>
      <div className="basis-full">
        <FormError message={testState.error ?? refreshState.error ?? restartState.error ?? deleteState.error} />
      </div>
    </div>
  );
}

/** Inline edit of an existing printer's own descriptive fields. Same shape as
 *  the "Add printer" form above (and the same stacked-on-mobile grid), just
 *  pre-filled and pointed at updatePrinterAction. */
function EditPrinterForm({ printer }: { printer: Printer }) {
  const [state, formAction, pending] = useActionState(updatePrinterAction, initialPrinterActionState);

  return (
    <form
      action={formAction}
      className="mb-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm sm:grid-cols-2"
    >
      <input type="hidden" name="printerId" value={printer.id} />
      <div>
        <FieldLabel htmlFor={`printerName-${printer.id}`}>Name</FieldLabel>
        <Input id={`printerName-${printer.id}`} name="name" defaultValue={printer.name} required />
      </div>
      <div>
        <FieldLabel htmlFor={`printerVendor-${printer.id}`}>Vendor</FieldLabel>
        <Input id={`printerVendor-${printer.id}`} name="vendor" defaultValue={printer.vendor ?? ""} />
      </div>
      <div>
        <FieldLabel htmlFor={`printerModel-${printer.id}`}>Model</FieldLabel>
        <Input id={`printerModel-${printer.id}`} name="model" defaultValue={printer.model ?? ""} />
      </div>
      <div>
        <FieldLabel htmlFor={`printerLocation-${printer.id}`}>Location</FieldLabel>
        <Input id={`printerLocation-${printer.id}`} name="location" defaultValue={printer.location ?? ""} />
      </div>
      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
        Status is reported by this printer&apos;s Agent, not set here - see docs/architecture.md sec 11.
      </p>
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" pending={pending} pendingLabel="Saving..." className="w-full sm:w-auto">
          Save printer
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormError message={state.error} />
        <FormSuccess message={state.success} />
      </div>
    </form>
  );
}

/** The administrator-declared fields of a printer_profile, shared verbatim by
 *  the create and the edit form so the two can never drift on what is
 *  editable, what the hints say, or how the booklet binding side is revealed.
 *  Presentational only - each caller owns its own useActionState/<form>. */
function ProfileFields({
  idPrefix,
  agents,
  defaults,
}: {
  idPrefix: string;
  agents: AgentInfo[];
  defaults: {
    key: string;
    label: string;
    description: string;
    iconKey: PrinterProfileIconKey | "";
    windowsQueueName: string;
    outputMode: "queue" | "raw";
    rawHost: string;
    rawPort: string;
    rawStaplePosition: "top-left" | "top-right";
    paperSizes: string;
    agentId: string;
    capabilities: Record<CapabilityKey, boolean>;
    bookletBindingSide: "left" | "right";
    isDefault: boolean;
  };
}) {
  const [iconKey, setIconKey] = useState<PrinterProfileIconKey | "">(defaults.iconKey);
  // Tracked separately from the other capability checkboxes (which stay
  // uncontrolled) purely so the binding-side field below can be shown/hidden
  // - it's meaningless for a non-booklet profile (see the column's own
  // comment in supabase/migrations/0017_*.sql).
  const [bookletChecked, setBookletChecked] = useState(defaults.capabilities.booklet);
  const [outputMode, setOutputMode] = useState<"queue" | "raw">(defaults.outputMode);
  const [rawHost, setRawHost] = useState(defaults.rawHost);
  const [rawHostTouched, setRawHostTouched] = useState(false);
  const [rawPort, setRawPort] = useState(defaults.rawPort);
  const rawHostError =
    rawHostTouched && rawHost.trim() && !isValidRawHost(rawHost.trim())
      ? "That isn't a valid IP address (like 192.168.1.50) or hostname."
      : null;
  const rawPortError = (() => {
    const r = parseRawPort(rawPort);
    return r.ok ? null : r.error;
  })();

  return (
    <>
      <div>
        <FieldLabel htmlFor={`${idPrefix}Key`} hint="internal only, never shown to users">
          Key
        </FieldLabel>
        <Input id={`${idPrefix}Key`} name="key" placeholder="booklet_saddle" defaultValue={defaults.key} required />
      </div>
      <div>
        <FieldLabel htmlFor={`${idPrefix}Label`} hint="what users see in the printer list">
          Label
        </FieldLabel>
        <Input id={`${idPrefix}Label`} name="label" placeholder="Booklet + Staple" defaultValue={defaults.label} required />
      </div>

      <div className="sm:col-span-2">
        <FieldLabel htmlFor={`${idPrefix}Description`} hint="optional - what a user sees below the label when picking a profile">
          Description
        </FieldLabel>
        <Input
          id={`${idPrefix}Description`}
          name="description"
          placeholder="Black & white, double-sided - everyday documents"
          defaultValue={defaults.description}
        />
      </div>

      <div className="sm:col-span-2">
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

      <div className="sm:col-span-2">
        <FieldLabel hint="how Printio gets the job onto the printer">Send jobs to</FieldLabel>
        <Select
          id={`${idPrefix}OutputMode`}
          name="outputMode"
          value={outputMode}
          onChange={(e) => setOutputMode(e.target.value === "raw" ? "raw" : "queue")}
        >
          <option value="queue">Windows queue</option>
          <option value="raw">Direct to printer (raw port 9100)</option>
        </Select>
      </div>

      {outputMode === "queue" ? (
        <div className="sm:col-span-2">
          <FieldLabel
            htmlFor={`${idPrefix}QueueName`}
            hint="must exactly match the queue name in Windows on that machine - case-sensitive"
          >
            Windows queue name
          </FieldLabel>
          <Input
            id={`${idPrefix}QueueName`}
            name="windowsQueueName"
            placeholder="Kyocera_Main_Booklet"
            defaultValue={defaults.windowsQueueName}
            required
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            On the Agent&apos;s Windows machine: Devices and Printers → right-click the queue →
            Printer properties → the name at the top. Copy it exactly - a typo here means the
            Agent can never find this queue.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
            The Agent sends the finished PDF straight to the printer over the network, with the
            stapling and booklet settings added by Printio itself. No Windows print queue or driver
            is involved. The printer must be reachable from the Agent&apos;s machine.
          </p>
          <div>
            <FieldLabel htmlFor={`${idPrefix}RawHost`} hint="the printer's IP address or network name">
              Printer address
            </FieldLabel>
            <Input
              id={`${idPrefix}RawHost`}
              name="rawHost"
              placeholder="192.168.1.50"
              value={rawHost}
              onChange={(e) => setRawHost(e.target.value)}
              onBlur={() => setRawHostTouched(true)}
              aria-invalid={rawHostError ? true : undefined}
              required
            />
            {rawHostError && <p className="mt-1 text-xs text-red-600">{rawHostError}</p>}
          </div>
          <div>
            <FieldLabel htmlFor={`${idPrefix}RawPort`} hint="almost always 9100">
              Port
            </FieldLabel>
            <Input
              id={`${idPrefix}RawPort`}
              name="rawPort"
              inputMode="numeric"
              placeholder="9100"
              value={rawPort}
              onChange={(e) => setRawPort(e.target.value)}
              aria-invalid={rawPortError ? true : undefined}
            />
            {rawPortError && <p className="mt-1 text-xs text-red-600">{rawPortError}</p>}
          </div>
          <div className="sm:col-span-2">
            <FieldLabel
              htmlFor={`${idPrefix}RawStaple`}
              hint="where the staple goes when a job asks for stapling (not used for booklets)"
            >
              Default staple position
            </FieldLabel>
            <Select id={`${idPrefix}RawStaple`} name="rawStaplePosition" defaultValue={defaults.rawStaplePosition}>
              <option value="top-left">Top left</option>
              <option value="top-right">Top right</option>
            </Select>
          </div>
        </>
      )}

      <div className="sm:col-span-2">
        <FieldLabel htmlFor={`${idPrefix}PaperSizes`} hint="comma-separated, matches what the driver's Printing Defaults offer">
          Paper sizes
        </FieldLabel>
        <Input id={`${idPrefix}PaperSizes`} name="paperSizes" placeholder="letter,a4,11x17" defaultValue={defaults.paperSizes} />
      </div>

      <div className="sm:col-span-2">
        <FieldLabel htmlFor={`${idPrefix}AgentId`} hint="which registered Agent's machine this Windows queue lives on">
          Agent
        </FieldLabel>
        <Select id={`${idPrefix}AgentId`} name="agentId" defaultValue={defaults.agentId} required>
          <option value="">Choose the agent that owns this queue…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="sm:col-span-2">
        <FieldLabel hint="check only what this queue's own Printing Defaults actually do (docs/printer-setup.md §3) - Printio never programs these itself, it only ever picks which queue to use">
          Capabilities
        </FieldLabel>
        <div className="flex flex-wrap gap-3">
          {CAPABILITY_KEYS.map((cap) =>
            cap === "booklet" ? (
              <label key={cap} className="flex items-center gap-1">
                <input type="checkbox" name={cap} checked={bookletChecked} onChange={(e) => setBookletChecked(e.target.checked)} /> {cap}
              </label>
            ) : (
              <label key={cap} className="flex items-center gap-1">
                <input type="checkbox" name={cap} defaultChecked={defaults.capabilities[cap]} /> {cap}
              </label>
            ),
          )}
        </div>
      </div>

      {bookletChecked && (
        <div className="sm:col-span-2">
          <FieldLabel
            htmlFor={`${idPrefix}BindingSide`}
            hint='matches the Kyocera KX driver’s own booklet "Left edge binding"/"Right edge binding" terminology (docs/printer-setup.md)'
          >
            Booklet binding side
          </FieldLabel>
          <Select id={`${idPrefix}BindingSide`} name="bookletBindingSide" defaultValue={defaults.bookletBindingSide}>
            <option value="left">Left edge binding (LTR reading)</option>
            <option value="right">Right edge binding (RTL reading, e.g. Hebrew)</option>
          </Select>
        </div>
      )}

      <label className="flex items-center gap-1 sm:col-span-2">
        <input type="checkbox" name="isDefault" defaultChecked={defaults.isDefault} /> Pre-select this profile in the print form
      </label>
    </>
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

  return (
    // One column on a phone, two once there's room. `col-span-2` on a
    // single-column grid would create a phantom second track, which is why
    // every wide field below uses `sm:col-span-2` instead.
    <form action={formAction} className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm sm:grid-cols-2">
      <input type="hidden" name="printerId" value={printerId} />

      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
        One profile per Windows print queue (or per direct-to-printer destination). Set up the queue itself first (driver, finishing
        defaults) per <code>docs/printer-setup.md</code> - this form just registers a queue
        that already exists, it doesn&apos;t create one.
      </p>

      <ProfileFields
        idPrefix={`newProfile-${printerId}-`}
        agents={agents}
        defaults={{
          key: "",
          label: "",
          description: "",
          iconKey: "",
          windowsQueueName: "",
          outputMode: "queue",
          rawHost: "",
          rawPort: "9100",
          rawStaplePosition: "top-left",
          paperSizes: "",
          agentId: "",
          capabilities: { duplex: false, color: false, staple: false, booklet: false, punch: false },
          bookletBindingSide: defaultBookletBindingSide,
          isDefault: false,
        }}
      />

      <div className="sm:col-span-2">
        <Button type="submit" size="sm" pending={pending} pendingLabel="Saving..." className="w-full">
          Save profile
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormError message={state.error} />
      </div>
    </form>
  );
}

/**
 * Inline edit of an existing profile, pre-filled with its current values.
 *
 * The two fields that matter most here are `windows_queue_name` and `Agent`:
 * when a printer moves to a different PC, or a queue is renamed in Windows,
 * re-pointing this profile is the whole fix - and until now it required
 * deleting and recreating the profile, which every historical print_jobs row
 * referencing it makes a bad idea. The profile deliberately stays on its
 * current printer (see updatePrinterProfileAction).
 */
function EditProfileForm({
  profile,
  agents,
  onClose,
}: {
  profile: PrinterProfile;
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(updatePrinterProfileAction, initialPrinterActionState);

  return (
    <form
      action={formAction}
      className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--color-border)] bg-white p-3 text-sm sm:grid-cols-2"
    >
      <input type="hidden" name="printerProfileId" value={profile.id} />

      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
        Editing <span className="font-medium">{profile.label}</span>. Re-pointing &ldquo;Windows queue name&rdquo; or
        &ldquo;Agent&rdquo; changes where every future job on this profile physically prints - existing jobs already
        sent are unaffected.
      </p>

      <ProfileFields
        idPrefix={`editProfile-${profile.id}-`}
        agents={agents}
        defaults={{
          key: profile.key,
          label: profile.label,
          description: profile.description ?? "",
          iconKey:
            profile.icon_key && profile.icon_key in PRINTER_PROFILE_ICON_COMPONENTS
              ? (profile.icon_key as PrinterProfileIconKey)
              : "",
          windowsQueueName: profile.windows_queue_name ?? "",
          outputMode: profile.output_mode === "raw" ? "raw" : "queue",
          rawHost: profile.raw_host ?? "",
          rawPort: String(profile.raw_port ?? 9100),
          rawStaplePosition: profile.raw_staple_position === "top-right" ? "top-right" : "top-left",
          paperSizes: profile.declared_paper_sizes.join(","),
          agentId: profile.agent_id,
          capabilities: readCapabilities(profile.declared_capabilities),
          bookletBindingSide: profile.booklet_binding_side === "right" ? "right" : "left",
          isDefault: profile.is_default,
        }}
      />

      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" size="sm" pending={pending} pendingLabel="Saving...">
          Save changes
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormError message={state.error} />
        <FormSuccess message={state.success} />
      </div>
    </form>
  );
}
