"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, RefreshCw, WifiOff, ArrowRight, ArrowLeft, ListChecks } from "lucide-react";
import Link from "next/link";
import { Button, ButtonLink, Card, Badge, Select, Input, FieldLabel, FormError, EmptyState } from "@/components/ui";
import { PRINTER_PROFILE_ICON_COMPONENTS, type PrinterProfileIconKey } from "@/lib/printer-profile-icons";
import { PRINTER_ARCHETYPE_IDS, PRINTER_ARCHETYPES, buildRecipeCards, isPrinterArchetypeId, type PrinterArchetypeId, type RecipeCard } from "@/lib/printer-setup-wizard";
import { createPrinterProfilesFromWizardAction, type PrinterActionState } from "../actions";
import { routes } from "@/lib/routes";
import { isValidRawHost, parseRawPort } from "@/lib/printers/raw-target";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialPrinterActionState: PrinterActionState = {};

export interface DiscoveredQueue {
  windowsQueueName: string;
  driverName?: string;
  portName?: string;
  status?: string;
}

export interface WizardAgent {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  discoveredQueues: DiscoveredQueue[];
}

export interface WizardPrinter {
  id: string;
  name: string;
}

// Same 5-min-without-a-heartbeat rule as app/admin/page.tsx's onlineCutoff,
// app/admin/agents/AgentsPanel.tsx's `online`, and
// app/admin/printers/PrintersPanel.tsx's AGENT_ONLINE_WINDOW_MS - reused
// here rather than inventing a new threshold, per this wizard's own step 2
// spec ("reuse whatever staleness threshold the existing printer/agent-status
// UI already uses elsewhere").
const AGENT_ONLINE_WINDOW_MS = 5 * 60_000;

function isAgentOnline(agent: WizardAgent): boolean {
  return agent.status === "active" && !!agent.lastSeenAt && Date.now() - new Date(agent.lastSeenAt).getTime() < AGENT_ONLINE_WINDOW_MS;
}

const SESSION_STORAGE_KEY = "printio.setupWizard.selectedArchetypes";

export function SetupWizard({
  printers,
  agents,
  claimedQueues,
  defaultBookletBindingSide,
}: {
  printers: WizardPrinter[];
  agents: WizardAgent[];
  /** windows_queue_name -> label of the existing printer_profiles row already
   *  using it (org-scoped) - purely informational, never blocks a choice. */
  claimedQueues: Record<string, string>;
  defaultBookletBindingSide: "left" | "right";
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selected, setSelected] = useState<Set<PrinterArchetypeId>>(new Set());

  // Step 1's selection is restored from sessionStorage on mount - a
  // convenience for an accidental refresh, not a hard requirement (step 3 is
  // where anything actually gets persisted - see this wizard's own spec).
  useEffect(() => {
    // Reads a browser-only API not available during SSR/hydration, so this
    // can only run as an effect (not a lazy useState initializer) without
    // risking a hydration mismatch - `selected` is already at its empty-Set
    // default, matching the server-rendered checklist, until this runs.
    try {
      const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return;
      const ids: unknown = JSON.parse(raw);
      if (Array.isArray(ids)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelected(new Set(ids.filter((id): id is PrinterArchetypeId => typeof id === "string" && isPrinterArchetypeId(id))));
      }
    } catch {
      // Private-browsing/blocked storage, or corrupt data - just start empty.
    }
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([...selected]));
    } catch {
      // Non-fatal - Step 1's checklist just won't survive a refresh this time.
    }
  }, [selected]);

  const selectedIdsInOrder = useMemo(() => PRINTER_ARCHETYPE_IDS.filter((id) => selected.has(id)), [selected]);
  const recipeCards = useMemo(() => buildRecipeCards(selectedIdsInOrder, defaultBookletBindingSide), [selectedIdsInOrder, defaultBookletBindingSide]);

  function toggleArchetype(id: PrinterArchetypeId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const onlineAgents = useMemo(() => agents.filter(isAgentOnline), [agents]);

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator step={step} />

      {step === 1 && (
        <Step1Plan
          selected={selected}
          onToggle={toggleArchetype}
          recipeCards={recipeCards}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <Step2RegisterMachine
          agents={agents}
          onlineAgents={onlineAgents}
          onRecheck={() => router.refresh()}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <Step3Finish
          printers={printers}
          agents={agents}
          onlineAgents={onlineAgents}
          claimedQueues={claimedQueues}
          recipeCards={recipeCards}
          onRecheck={() => router.refresh()}
          onBack={() => setStep(2)}
        />
      )}
    </div>
  );
}

/** Leave the wizard without saving anything. */
function CancelLink() {
  return (
    <ButtonLink href={routes.adminPrinters} variant="ghost">
      Cancel
    </ButtonLink>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  const labels: Record<1 | 2 | 3, string> = { 1: "Plan", 2: "Register the machine", 3: "Finish" };
  return (
    <div className="flex items-center gap-2 text-xs font-medium text-[var(--color-muted)]">
      {([1, 2, 3] as const).map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full ${
              n === step ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : n < step ? "bg-[var(--color-success)] text-white" : "bg-gray-200 text-gray-500"
            }`}
          >
            {n}
          </span>
          <span className={n === step ? "text-[var(--color-text)]" : ""}>{labels[n]}</span>
          {i < 2 && <ArrowRight className="h-3.5 w-3.5" />}
        </div>
      ))}
    </div>
  );
}

function Step1Plan({
  selected,
  onToggle,
  recipeCards,
  onNext,
}: {
  selected: Set<PrinterArchetypeId>;
  onToggle: (id: PrinterArchetypeId) => void;
  recipeCards: RecipeCard[];
  onNext: () => void;
}) {
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Step 1: Plan your profiles</h2>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Check every finishing type you need. Each one becomes a suggested profile below - you&apos;ll map it to a
        real Windows queue in Step 3.
      </p>

      <ul className="mb-6 flex flex-col gap-2">
        {PRINTER_ARCHETYPE_IDS.map((id) => {
          const archetype = PRINTER_ARCHETYPES[id];
          return (
            <li key={id}>
              <label className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
                <input type="checkbox" checked={selected.has(id)} onChange={() => onToggle(id)} />
                {archetype.checklistLabel}
              </label>
            </li>
          );
        })}
      </ul>

      {recipeCards.length > 0 && (
        <>
          <h3 className="mb-2 text-sm font-semibold">Recipe cards</h3>
          <ul className="mb-6 flex flex-col gap-3">
            {recipeCards.map((card) => (
              <RecipeCardPreview key={card.archetypeId} card={card} />
            ))}
          </ul>
        </>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CancelLink />
        <Button type="button" onClick={onNext} disabled={recipeCards.length === 0}>
          Next: Register the machine <ArrowRight className="ml-1 inline h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function RecipeCardPreview({ card }: { card: RecipeCard }) {
  const Icon = PRINTER_PROFILE_ICON_COMPONENTS[card.iconKey as PrinterProfileIconKey];
  const activeCaps = Object.entries(card.declaredCapabilities).filter(([, v]) => v);
  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
        <span className="font-medium">{card.label}</span>
        <code className="text-xs text-[var(--color-muted)]">{card.key}</code>
      </div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{card.description}</p>
      <p className="mt-1 flex flex-wrap gap-1">
        {activeCaps.length > 0 ? (
          activeCaps.map(([cap]) => (
            <Badge key={cap} tone="neutral">
              {cap}
            </Badge>
          ))
        ) : (
          <Badge tone="neutral">no special capabilities</Badge>
        )}
        {card.isBooklet && <Badge tone="neutral">{card.bookletBindingSide} edge binding</Badge>}
      </p>
      <p className="mt-2 text-xs text-[var(--color-text)]">{card.driverGuidance}</p>
    </li>
  );
}

function Step2RegisterMachine({
  agents,
  onlineAgents,
  onRecheck,
  onBack,
  onNext,
}: {
  agents: WizardAgent[];
  onlineAgents: WizardAgent[];
  onRecheck: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const ready = onlineAgents.length > 0;
  // Only meaningful client-side (window is undefined during server
  // rendering) - this is exactly the value setup-agent.bat's first prompt
  // asks for, so showing it here removes the one piece of information nobody
  // ever tells the person standing at the Windows machine.
  const apiUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Step 2: Register the machine</h2>

      <ol className="mb-4 flex list-decimal flex-col gap-3 pl-5 text-sm text-[var(--color-muted)]">
        <li>
          Get an enrollment code first - go to{" "}
          <Link href={routes.adminAgents} target="_blank" className="text-[var(--color-primary)] underline">
            Admin &rarr; Agents
          </Link>{" "}
          and click &quot;Register new agent.&quot; The code appears on that agent&apos;s own row and stays there
          (valid 24h) until it&apos;s used - come back to this tab afterward, you don&apos;t need to close it.
        </li>
        <li>
          On the Windows machine with your printer queues already set up, open the <code>printio</code> folder and
          double-click <code>apps\agent\scripts\setup-agent.bat</code>.
        </li>
        <li>
          When it asks for your organization&apos;s cloud URL, enter exactly:{" "}
          {apiUrl && (
            <code className="rounded bg-gray-100 px-2 py-1 font-mono text-[var(--color-text)]">{apiUrl}</code>
          )}
          . When it asks for the enrollment code, paste the one from step 1.
        </li>
        <li>
          Choose option 1 (run now) to test, or 2 to install as a permanent Windows service. Come back here once it
          says it&apos;s heartbeating successfully - see <code>docs/agent-install.md</code>&apos;s &quot;fast
          path&quot; if anything above doesn&apos;t match what you see.
        </li>
      </ol>

      <div className="mb-4 rounded-lg border border-[var(--color-border)] p-3">
        {ready ? (
          <p className="flex items-center gap-2 text-sm text-[var(--color-success)]">
            <CheckCircle2 className="h-4 w-4" /> {onlineAgents.length} Agent{onlineAgents.length > 1 ? "s" : ""} online and ready
            ({onlineAgents.map((a) => a.name).join(", ")}).
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
            <WifiOff className="h-4 w-4" /> No Agent is online yet
            {agents.length > 0 ? ` (${agents.length} registered, none active/recent)` : " (none registered yet)"}.
          </p>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onRecheck} className="mt-2">
          <RefreshCw className="mr-1 inline h-3.5 w-3.5" /> Recheck status
        </Button>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onBack}>
            <ArrowLeft className="mr-1 inline h-4 w-4" /> Back
          </Button>
          <CancelLink />
        </div>
        <Button type="button" onClick={onNext} disabled={!ready}>
          Next: Finish <ArrowRight className="ml-1 inline h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function Step3Finish({
  printers,
  agents,
  onlineAgents,
  claimedQueues,
  recipeCards,
  onRecheck,
  onBack,
}: {
  printers: WizardPrinter[];
  agents: WizardAgent[];
  onlineAgents: WizardAgent[];
  claimedQueues: Record<string, string>;
  recipeCards: RecipeCard[];
  onRecheck: () => void;
  onBack: () => void;
}) {
  const [state, formAction, pending] = useActionState(createPrinterProfilesFromWizardAction, initialPrinterActionState);

  const [agentId, setAgentId] = useState(() => onlineAgents[0]?.id ?? agents[0]?.id ?? "");
  const [printerId, setPrinterId] = useState(() => (printers.length === 1 ? (printers[0]?.id ?? "") : ""));
  const [newPrinterName, setNewPrinterName] = useState("");
  const [outputMode, setOutputMode] = useState<"queue" | "raw">("queue");
  const [rawHost, setRawHost] = useState("");
  const [rawHostTouched, setRawHostTouched] = useState(false);
  const [rawPort, setRawPort] = useState("9100");
  const [rawStaple, setRawStaple] = useState<"top-left" | "top-right">("top-left");
  const [queueByCardKey, setQueueByCardKey] = useState<Record<string, string>>({});
  const [bindingSideByCardKey, setBindingSideByCardKey] = useState<Record<string, "left" | "right">>(() =>
    Object.fromEntries(recipeCards.filter((c) => c.isBooklet).map((c) => [c.key, c.bookletBindingSide])),
  );

  const selectedAgent = agents.find((a) => a.id === agentId);
  const discoveredQueues = selectedAgent?.discoveredQueues ?? [];

  const creatingNewPrinter = printerId === "" && printers.length !== 1;
  const isRaw = outputMode === "raw";
  const rawHostError = rawHostTouched && rawHost.trim() && !isValidRawHost(rawHost.trim()) ? "That isn't a valid IP address (like 192.168.1.50) or hostname." : null;
  const rawPortParsed = parseRawPort(rawPort);
  const rawPortError = rawPortParsed.ok ? null : rawPortParsed.error;
  const allQueuesChosen = isRaw
    ? isValidRawHost(rawHost.trim()) && rawPortParsed.ok
    : recipeCards.every((c) => !!queueByCardKey[c.key]);
  const canSubmit = !!agentId && (printerId !== "" || (creatingNewPrinter && newPrinterName.trim() !== "")) && allQueuesChosen && !pending;

  const cardsPayload = recipeCards.map((c) => ({
    key: c.key,
    label: c.label,
    description: c.description,
    iconKey: c.iconKey,
    declaredCapabilities: c.declaredCapabilities,
    bookletBindingSide: c.isBooklet ? (bindingSideByCardKey[c.key] ?? c.bookletBindingSide) : c.bookletBindingSide,
    windowsQueueName: isRaw ? "" : (queueByCardKey[c.key] ?? ""),
  }));

  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Step 3: Map recipe cards to real queues</h2>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Pick which Agent owns these queues, which printer they belong to, then choose the real Windows queue name for
        each profile below.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="printerId" value={printerId} />
        <input type="hidden" name="newPrinterName" value={printerId === "" ? newPrinterName.trim() : ""} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="outputMode" value={outputMode} />
        <input type="hidden" name="cardsJson" value={JSON.stringify(cardsPayload)} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="wizardAgent">Agent</FieldLabel>
            <Select id="wizardAgent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Choose the Agent that owns these queues…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} {isAgentOnline(a) ? "(online)" : "(offline)"}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="wizardPrinter">Printer</FieldLabel>
            <Select id="wizardPrinter" value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
              <option value="">+ Add a new printer…</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {printerId === "" && (
              <Input
                className="mt-2"
                placeholder="New printer name, e.g. Main Office Kyocera"
                value={newPrinterName}
                onChange={(e) => setNewPrinterName(e.target.value)}
              />
            )}
          </div>
        </div>

        <div>
          <FieldLabel htmlFor="wizardOutputMode" hint="how Printio gets jobs onto the printer">
            Send jobs to
          </FieldLabel>
          <Select id="wizardOutputMode" value={outputMode} onChange={(e) => setOutputMode(e.target.value === "raw" ? "raw" : "queue")}>
            <option value="queue">Windows queue</option>
            <option value="raw">Direct to printer (raw port 9100)</option>
          </Select>
        </div>

        {isRaw && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
              The Agent sends each PDF straight to the printer over the network and Printio adds the stapling and
              booklet settings itself - no Windows queue or driver needed. The printer must be reachable from the
              Agent&apos;s machine.
            </p>
            <div>
              <FieldLabel htmlFor="wizardRawHost" hint="IP address or network name">
                Printer address
              </FieldLabel>
              <Input
                id="wizardRawHost"
                name="rawHost"
                placeholder="192.168.1.50"
                value={rawHost}
                onChange={(e) => setRawHost(e.target.value)}
                onBlur={() => setRawHostTouched(true)}
                aria-invalid={rawHostError ? true : undefined}
              />
              {rawHostError && <p className="mt-1 text-xs text-red-600">{rawHostError}</p>}
            </div>
            <div>
              <FieldLabel htmlFor="wizardRawPort" hint="almost always 9100">
                Port
              </FieldLabel>
              <Input id="wizardRawPort" name="rawPort" inputMode="numeric" placeholder="9100" value={rawPort} onChange={(e) => setRawPort(e.target.value)} aria-invalid={rawPortError ? true : undefined} />
              {rawPortError && <p className="mt-1 text-xs text-red-600">{rawPortError}</p>}
            </div>
            <div className="sm:col-span-2">
              <FieldLabel htmlFor="wizardRawStaple" hint="where the staple goes for stapled jobs">
                Default staple position
              </FieldLabel>
              <Select id="wizardRawStaple" name="rawStaplePosition" value={rawStaple} onChange={(e) => setRawStaple(e.target.value === "top-right" ? "top-right" : "top-left")}>
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
              </Select>
            </div>
          </div>
        )}

        {agentId && !isRaw && discoveredQueues.length === 0 && (
          <EmptyState
            message="This Agent hasn't reported any Windows queues yet. Set up the queue(s) in Windows per docs/printer-setup.md, then wait for its next heartbeat (or recheck below)."
            icon={ListChecks}
            action={
              <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
                <RefreshCw className="mr-1 inline h-3.5 w-3.5" /> Recheck
              </Button>
            }
          />
        )}

        {agentId && (isRaw || discoveredQueues.length > 0) && (
          <ul className="flex flex-col gap-3">
            {recipeCards.map((card) => {
              const Icon = PRINTER_PROFILE_ICON_COMPONENTS[card.iconKey as PrinterProfileIconKey];
              return (
                <li key={card.key} className="rounded-lg border border-[var(--color-border)] p-3">
                  <div className="mb-2 flex items-center gap-2">
                    {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                    <span className="font-medium">{card.label}</span>
                  </div>
                  {!isRaw && (
                  <>
                  <FieldLabel htmlFor={`queue-${card.key}`}>Windows queue</FieldLabel>
                  <Select
                    id={`queue-${card.key}`}
                    value={queueByCardKey[card.key] ?? ""}
                    onChange={(e) => setQueueByCardKey((prev) => ({ ...prev, [card.key]: e.target.value }))}
                  >
                    <option value="">Choose a discovered queue…</option>
                    {discoveredQueues.map((q) => (
                      <option key={q.windowsQueueName} value={q.windowsQueueName}>
                        {q.windowsQueueName}
                        {claimedQueues[q.windowsQueueName] ? ` (already used by "${claimedQueues[q.windowsQueueName]}")` : ""}
                      </option>
                    ))}
                  </Select>
                  </>
                  )}

                  {card.isBooklet && (
                    <div className="mt-2">
                      <FieldLabel htmlFor={`binding-${card.key}`}>Booklet binding side</FieldLabel>
                      <Select
                        id={`binding-${card.key}`}
                        value={bindingSideByCardKey[card.key] ?? card.bookletBindingSide}
                        onChange={(e) => setBindingSideByCardKey((prev) => ({ ...prev, [card.key]: e.target.value === "right" ? "right" : "left" }))}
                      >
                        <option value="left">Left edge binding (LTR reading)</option>
                        <option value="right">Right edge binding (RTL reading, e.g. Hebrew)</option>
                      </Select>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <FormError message={state.error} />

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onBack}>
              <ArrowLeft className="mr-1 inline h-4 w-4" /> Back
            </Button>
            <CancelLink />
          </div>
          <Button type="submit" disabled={!canSubmit} pending={pending} pendingLabel="Creating profiles...">
            Create {recipeCards.length} profile{recipeCards.length === 1 ? "" : "s"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
