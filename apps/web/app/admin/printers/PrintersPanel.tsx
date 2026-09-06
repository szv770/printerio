"use client";

import { useActionState, useState } from "react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, Select, FieldLabel, FormError, EmptyState, Badge, Card } from "@/components/ui";
import {
  createPrinterAction,
  createPrinterProfileAction,
  refreshPrinterStatusAction,
  restartPrintQueueAction,
  initialPrinterActionState,
} from "./actions";

type Printer = Tables<"printers">;
type PrinterProfile = Tables<"printer_profiles">;
interface AgentInfo {
  id: string;
  name: string;
  last_seen_at: string | null;
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
}: {
  printers: Printer[];
  profiles: PrinterProfile[];
  agents: AgentInfo[];
  canManage: boolean;
}) {
  const [createPrinterState, createPrinterAct, creatingPrinter] = useActionState(createPrinterAction, initialPrinterActionState);
  const [showNewProfileFor, setShowNewProfileFor] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
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
              <Input id="model" name="model" placeholder="TASKalfa MZ2501ci" />
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
                    return (
                      <li key={p.id} className="rounded bg-gray-50 px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span>
                            <span className="font-medium">{p.label}</span> ({p.key}) — queue <code>{p.windows_queue_name}</code>
                          </span>
                          {canManage && <ProfileRemoteActions printer={printer} profile={p} />}
                        </div>
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

                {showNewProfileFor === printer.id && <NewProfileForm printerId={printer.id} agents={agents} />}
              </Card>
            </li>
          );
        })}
        {printers.length === 0 && <EmptyState message="No printers yet." />}
      </ul>

      <p className="text-xs text-[var(--color-muted)]">
        Capabilities and paper sizes above are administrator-declared, not verified against the physical device by
        PrintOS - see docs/printer-setup.md for how to actually configure a Windows queue&apos;s finishing defaults before
        declaring them here. Status only ever reflects what the Agent last reported at heartbeat time (docs/architecture.md
        sec 11) - it is not polled live.
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
  return (
    <Badge tone={online ? "success" : "neutral"}>
      Agent: {agent.name} • {online ? "online" : "offline"}
    </Badge>
  );
}

/** "Refresh status"/"Restart queue" - issues a fixed, allow-listed remote
 *  command (docs/architecture.md sec 12) via a Server Action, never a raw
 *  fetch() from the client. */
function ProfileRemoteActions({ printer, profile }: { printer: Printer; profile: PrinterProfile }) {
  const [refreshState, refreshAction, refreshPending] = useActionState(refreshPrinterStatusAction, initialPrinterActionState);
  const [restartState, restartAction, restartPending] = useActionState(restartPrintQueueAction, initialPrinterActionState);

  return (
    <div className="flex shrink-0 items-center gap-2">
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
      <FormError message={refreshState.error ?? restartState.error} />
    </div>
  );
}

function NewProfileForm({
  printerId,
  agents,
}: {
  printerId: string;
  agents: AgentInfo[];
}) {
  const [state, formAction, pending] = useActionState(createPrinterProfileAction, initialPrinterActionState);

  return (
    <form action={formAction} className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-[var(--color-border)] p-3 text-sm">
      <input type="hidden" name="printerId" value={printerId} />
      <Input name="key" placeholder="key (e.g. booklet_saddle)" required />
      <Input name="label" placeholder="Label (e.g. Booklet + Staple)" required />
      <Input name="windowsQueueName" placeholder="Windows queue name" required className="col-span-2" />
      <Input name="paperSizes" placeholder="letter,a4,11x17" className="col-span-2" />
      <Select name="agentId" required className="col-span-2">
        <option value="">Choose the agent that owns this queue…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <div className="col-span-2 flex flex-wrap gap-3">
        {(["duplex", "color", "staple", "booklet", "punch"] as const).map((cap) => (
          <label key={cap} className="flex items-center gap-1">
            <input type="checkbox" name={cap} /> {cap}
          </label>
        ))}
        <label className="flex items-center gap-1">
          <input type="checkbox" name="isDefault" /> default
        </label>
      </div>
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
