"use client";

import { useActionState, useState } from "react";
import { FileCheck2, Info, Pause, Pencil, Plus, Printer as PrinterIcon, Trash2, Wand2, Wifi, WifiOff } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { isValidRawHost, parseRawPort } from "@/lib/printers/raw-target";
import {
  Badge,
  Button,
  ButtonLink,
  Collapsible,
  EmptyState,
  Field,
  FieldLabel,
  FormError,
  FormSuccess,
  Input,
  Select,
  StatusDot,
  type StatusTone,
} from "@/components/ui";
import { routes } from "@/lib/routes";
import { printerNeedsAttention, printerStatusWord, printerSummary, printerTone } from "@/lib/admin/summaries";
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
    <div className="flex flex-col gap-4" data-tour="admin-printers-panel">
      {printers.length === 0 ? (
        <EmptyState
          title="No printers yet"
          message={canManage ? "Add your first printer below." : "An admin needs to add a printer."}
          icon={PrinterIcon}
        />
      ) : (
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
        </ul>
      )}

      {canManage && (
        <Collapsible
          id="add-printer"
          title="Add a printer"
          icon={<Plus className="h-4 w-4" />}
          summary="Give a new printer a name and a place"
          forceOpen={!!createPrinterState.error}
        >
          {/* Mobile-first: every field is full width and stacked, and only
           *  pairs up once there is room for it (sm:). */}
          <form action={createPrinterAct} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="name">
              <Input id="name" name="name" required placeholder="Main office printer" />
            </Field>
            <Field label="Maker" htmlFor="vendor" hint="optional">
              <Input id="vendor" name="vendor" placeholder="Kyocera" />
            </Field>
            <Field label="Model" htmlFor="model" hint="optional">
              <Input id="model" name="model" placeholder="TASKalfa MZ8500i" />
            </Field>
            <Field label="Where it is" htmlFor="location" hint="optional">
              <Input id="location" name="location" placeholder="Front office" />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" pending={creatingPrinter} pendingLabel="Adding..." className="w-full sm:w-auto">
                Add printer
              </Button>
            </div>
            <div className="sm:col-span-2">
              <FormError message={createPrinterState.error} />
            </div>
          </form>
        </Collapsible>
      )}

      {canManage && (
        <div data-tour="admin-printers-wizard-link">
          <Collapsible
            id="advanced"
            title="Advanced"
            icon={<Wand2 className="h-4 w-4" />}
            summary="Step-by-step setup for Windows print queues"
          >
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-[var(--color-text-2)]">
                The guided wizard plans which print queues you need, checks the print server is online, and connects each one to
                a real queue on that computer. Use it the first time, or when you move printers to a new computer.
              </p>
              <ButtonLink href={routes.adminPrintersSetup} variant="secondary" className="w-full sm:w-auto">
                <Wand2 className="h-4 w-4" aria-hidden="true" /> Open the setup wizard
              </ButtonLink>
            </div>
          </Collapsible>
        </div>
      )}

      <Collapsible
        id="about-status"
        title="About status and test prints"
        icon={<Info className="h-4 w-4" />}
        summary="What the dots mean and what a test print does"
      >
        <div className="flex flex-col gap-2 text-sm text-[var(--color-text-2)]">
          <p>
            Paper sizes and finishing options are what you tell Printio. It does not check them against the real printer, so set
            up each Windows queue first.
          </p>
          <p>Status is what the print server last reported. It is not checked live.</p>
          <p>
            &ldquo;Send test print&rdquo; sends one real page the same way a user&apos;s job goes, to that queue, and opens its
            status page so you can watch it. It skips print rules, approval and limits, and is left out of usage reports.
          </p>
        </div>
      </Collapsible>
    </div>
  );
}

function StatusDotOnly({ tone }: { tone: StatusTone }) {
  const color: Record<StatusTone, string> = {
    neutral: "bg-[var(--color-faint)]",
    live: "bg-[var(--ink-c)]",
    success: "bg-[var(--color-success)]",
    warning: "bg-[var(--ink-y)]",
    danger: "bg-[var(--ink-m)]",
  };
  return <span aria-hidden="true" className={`block h-3 w-3 rounded-full ${color[tone]}`} />;
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

  const serverIds = new Set(profiles.map((p) => p.agent_id));
  const servers = agents.filter((a) => serverIds.has(a.id));
  const where = [printer.vendor, printer.model].filter(Boolean).join(" ");

  return (
    <li>
      <Collapsible
        id={`printer-${printer.id}`}
        title={printer.name}
        icon={<PrinterIcon className="h-4 w-4" />}
        summary={printerSummary({ status: printer.status, queues: profiles.length, serverName: servers[0]?.name ?? null })}
        badge={<StatusDotOnly tone={printerTone(printer.status)} />}
        forceOpen={printerNeedsAttention(printer.status)}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <StatusDot tone={printerTone(printer.status)}>{printerStatusWord(printer.status)}</StatusDot>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">
              {[where, printer.location].filter(Boolean).join(" · ") || "No details added"}
              {printer.last_status_at && ` · last heard from ${new Date(printer.last_status_at).toLocaleString()}`}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setEditingPrinter((v) => !v)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {editingPrinter ? "Close" : "Edit printer"}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowNewProfile((v) => !v)}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {showNewProfile ? "Close" : "Add a print queue"}
              </Button>
            </div>
          )}
        </div>

        {editingPrinter && <EditPrinterForm printer={printer} />}

        <h3 className="mb-2 text-sm font-semibold">Print queues</h3>
        <ul className="flex flex-col gap-2 text-sm">
          {profiles.map((p) => {
            const owningAgent = agents.find((a) => a.id === p.agent_id);
            const ProfileIcon =
              p.icon_key && p.icon_key in PRINTER_PROFILE_ICON_COMPONENTS
                ? PRINTER_PROFILE_ICON_COMPONENTS[p.icon_key as PrinterProfileIconKey]
                : null;
            const capabilities = readCapabilities(p.declared_capabilities);
            return (
              <li key={p.id} className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3.5">
                <span className="flex min-w-0 items-start gap-2">
                  {ProfileIcon && <ProfileIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                  <span className="min-w-0 break-words">
                    <span className="font-semibold">{p.label}</span>
                    <span className="block text-[13px] text-[var(--color-muted)]">
                      {p.output_mode === "raw" ? (
                        <>
                          Straight to{" "}
                          <code className="font-mono">
                            {p.raw_host}:{p.raw_port}
                          </code>
                        </>
                      ) : (
                        <>
                          Windows queue <code className="font-mono">{p.windows_queue_name}</code>
                        </>
                      )}
                    </span>
                  </span>
                </span>
                {p.description && <p className="mt-1.5 text-[13px] text-[var(--color-text-2)]">{p.description}</p>}
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--color-muted)]">
                  <span>
                    Paper: {p.declared_paper_sizes.join(", ") || "not set"} · Can do:{" "}
                    {CAPABILITY_KEYS.filter((k) => capabilities[k]).join(", ") || "nothing special"}
                  </span>
                  {owningAgent && <AgentOnlineBadge agent={owningAgent} />}
                </p>
                {canManage && (
                  <ProfileRowActions
                    printer={printer}
                    profile={p}
                    isEditing={editingProfileId === p.id}
                    onToggleEdit={() => setEditingProfileId(editingProfileId === p.id ? null : p.id)}
                  />
                )}
                {canManage && editingProfileId === p.id && (
                  <EditProfileForm profile={p} agents={agents} onClose={() => setEditingProfileId(null)} />
                )}
              </li>
            );
          })}
          {profiles.length === 0 && <li className="text-[13px] text-[var(--color-muted)]">No print queues yet. Add one so people can print here.</li>}
        </ul>

        {canManage && showNewProfile && (
          <NewProfileForm printerId={printer.id} agents={agents} defaultBookletBindingSide={defaultBookletBindingSide} />
        )}
      </Collapsible>
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
          Server {agent.name}, paused
        </span>
      </Badge>
    );
  }
  return (
    <Badge tone={online ? "success" : "neutral"}>
      <span className="flex items-center gap-1">
        {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        Server {agent.name}, {online ? "online" : "offline"}
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
    <div className="mt-3 flex flex-wrap items-center gap-2">
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
          if (!confirm(`Delete the "${profile.label}" print queue? People will no longer be able to pick it.`)) {
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
      className="mb-3 grid grid-cols-1 gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm sm:grid-cols-2"
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
        Status comes from the print server, so it cannot be set here.
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
        <FieldLabel htmlFor={`${idPrefix}Key`} hint="internal, users never see it">
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
        <FieldLabel  >How jobs reach the printer</FieldLabel>
        <Select
          id={`${idPrefix}OutputMode`}
          name="outputMode"
          value={outputMode}
          onChange={(e) => setOutputMode(e.target.value === "raw" ? "raw" : "queue")}
        >
          <option value="queue">Windows queue</option>
          <option value="raw">Straight to the printer (port 9100)</option>
        </Select>
      </div>

      {outputMode === "queue" ? (
        <div className="sm:col-span-2">
          <FieldLabel
            htmlFor={`${idPrefix}QueueName`}
            hint="must match the name in Windows exactly, capitals included"
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
            On the print server computer: Devices and Printers, right-click the queue, Printer properties, and copy the name at the top exactly. A typo means the queue can never be found.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
            The print server sends the finished file straight to the printer over the network, with stapling and booklet
            settings added by Printio. No Windows queue or driver is involved. The printer must be reachable from the print
            server computer.
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
            {rawHostError && <p className="mt-1 text-[13px] text-[var(--color-danger)]">{rawHostError}</p>}
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
            {rawPortError && <p className="mt-1 text-[13px] text-[var(--color-danger)]">{rawPortError}</p>}
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
        <FieldLabel htmlFor={`${idPrefix}AgentId`} hint="the computer this queue lives on">
          Print server
        </FieldLabel>
        <Select id={`${idPrefix}AgentId`} name="agentId" defaultValue={defaults.agentId} required>
          <option value="">Choose the print server for this queue…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="sm:col-span-2">
        <FieldLabel hint="tick only what this queue really does when it prints">
          What it can do
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
            hint='same as the Kyocera driver: "Left edge binding" or "Right edge binding"'
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
        <input type="checkbox" name="isDefault" defaultChecked={defaults.isDefault} /> Pick this one first when someone prints
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
    <form action={formAction} className="mt-3 grid grid-cols-1 gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm sm:grid-cols-2">
      <input type="hidden" name="printerId" value={printerId} />

      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
        One entry per Windows print queue (or per direct-to-printer address). Set the queue up in Windows first, with its driver and finishing
        defaults. This form only connects Printio to a queue that already exists.
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
          Save print queue
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
      className="mt-3 grid grid-cols-1 gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm sm:grid-cols-2"
    >
      <input type="hidden" name="printerProfileId" value={profile.id} />

      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
        Editing <span className="font-medium">{profile.label}</span>. Changing the Windows queue name or the print server changes where every future job on this queue prints. Jobs already
        sent are not affected.
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
