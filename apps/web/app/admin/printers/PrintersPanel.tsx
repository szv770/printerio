"use client";

import { useActionState, useState } from "react";
import type { Tables } from "@/lib/database.types";
import { createPrinterAction, createPrinterProfileAction, initialPrinterActionState } from "./actions";

type Printer = Tables<"printers">;
type PrinterProfile = Tables<"printer_profiles">;

export function PrintersPanel({
  printers,
  profiles,
  agents,
  canManage,
}: {
  printers: Printer[];
  profiles: PrinterProfile[];
  agents: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const [createPrinterState, createPrinterAct, creatingPrinter] = useActionState(createPrinterAction, initialPrinterActionState);
  const [showNewProfileFor, setShowNewProfileFor] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <form action={createPrinterAct} className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border)] p-4">
          <div>
            <label className="mb-1 block text-xs font-medium">Name</label>
            <input name="name" required placeholder="Main Office Kyocera" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Vendor</label>
            <input name="vendor" placeholder="Kyocera" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Model</label>
            <input name="model" placeholder="TASKalfa MZ2501ci" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Location</label>
            <input name="location" placeholder="Front office" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={creatingPrinter} className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-white disabled:opacity-60">
            {creatingPrinter ? "Adding..." : "Add printer"}
          </button>
          {createPrinterState.error && <p className="w-full text-sm text-[var(--color-danger)]">{createPrinterState.error}</p>}
        </form>
      )}

      <ul className="flex flex-col gap-4">
        {printers.map((printer) => {
          const printerProfiles = profiles.filter((p) => p.printer_id === printer.id);
          return (
            <li key={printer.id} className="rounded-xl border border-[var(--color-border)] p-4">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="font-medium">{printer.name}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {printer.vendor} {printer.model} {printer.location ? `• ${printer.location}` : ""}
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
                {printerProfiles.map((p) => (
                  <li key={p.id} className="rounded bg-gray-50 px-3 py-2">
                    <span className="font-medium">{p.label}</span> ({p.key}) — queue <code>{p.windows_queue_name}</code>
                    <p className="text-xs text-[var(--color-muted)]">
                      Declared: {p.declared_paper_sizes.join(", ")} •{" "}
                      {Object.entries(p.declared_capabilities as Record<string, boolean>)
                        .filter(([, v]) => v)
                        .map(([k]) => k)
                        .join(", ") || "no special capabilities"}
                    </p>
                  </li>
                ))}
                {printerProfiles.length === 0 && <p className="text-xs text-[var(--color-muted)]">No finishing profiles yet.</p>}
              </ul>

              {showNewProfileFor === printer.id && <NewProfileForm printerId={printer.id} agents={agents} />}
            </li>
          );
        })}
        {printers.length === 0 && <p className="text-sm text-[var(--color-muted)]">No printers yet.</p>}
      </ul>

      <p className="text-xs text-[var(--color-muted)]">
        Capabilities and paper sizes above are administrator-declared, not verified against the physical device by
        PrintOS - see docs/printer-setup.md for how to actually configure a Windows queue&apos;s finishing defaults before
        declaring them here.
      </p>
    </div>
  );
}

function NewProfileForm({
  printerId,
  agents,
}: {
  printerId: string;
  agents: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState(createPrinterProfileAction, initialPrinterActionState);

  return (
    <form action={formAction} className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-[var(--color-border)] p-3 text-sm">
      <input type="hidden" name="printerId" value={printerId} />
      <input name="key" placeholder="key (e.g. booklet_saddle)" required className="rounded border border-[var(--color-border)] px-2 py-1.5" />
      <input name="label" placeholder="Label (e.g. Booklet + Staple)" required className="rounded border border-[var(--color-border)] px-2 py-1.5" />
      <input name="windowsQueueName" placeholder="Windows queue name" required className="col-span-2 rounded border border-[var(--color-border)] px-2 py-1.5" />
      <input name="paperSizes" placeholder="letter,a4,11x17" className="col-span-2 rounded border border-[var(--color-border)] px-2 py-1.5" />
      <select name="agentId" required className="col-span-2 rounded border border-[var(--color-border)] px-2 py-1.5">
        <option value="">Choose the agent that owns this queue…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
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
      <button type="submit" disabled={pending} className="col-span-2 rounded bg-[var(--color-primary)] px-3 py-1.5 text-white disabled:opacity-60">
        {pending ? "Saving..." : "Save profile"}
      </button>
      {state.error && <p className="col-span-2 text-[var(--color-danger)]">{state.error}</p>}
    </form>
  );
}
