"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Check, Copy, Laptop, Monitor, MonitorSmartphone, Plus, Smartphone, Tablet, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  Button,
  Card,
  Collapsible,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  FormError,
  FormSuccess,
  Input,
  StatusDot,
  Textarea,
  type StatusTone,
} from "@/components/ui";
import { ISSUE_KINDS, issueKindLabel, MAX_ISSUE_NOTE } from "@/lib/devices/admin";
import { detectDeviceType, deviceAddress, deviceStatus, deviceTypeLabel, noStepsMessage, setupSteps } from "@/lib/devices/present";
import { LocalTime } from "../jobs/LocalTime";
import {
  addDeviceAction,
  deleteDeviceAction,
  reportIssueAction,
  revokeDeviceAction,
  type AddDeviceState,
  type DeleteDeviceState,
  type ReportIssueState,
  type RevokeDeviceState,
} from "./actions";

export interface DeviceItem {
  id: string;
  name: string;
  device_type: string;
  created_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  first_job_at: string | null;
  first_printed_at: string | null;
  /** Problems this member reported that nobody has resolved yet. */
  open_issues?: number;
}

const TYPE_OPTIONS: { value: string; label: string; Icon: LucideIcon }[] = [
  { value: "windows", label: "Windows 11", Icon: Monitor },
  { value: "android", label: "Android (Pixel)", Icon: Smartphone },
  { value: "chromebook", label: "Chromebook", Icon: Laptop },
  { value: "iphone", label: "iPhone / iPad", Icon: Tablet },
  { value: "mac", label: "Mac", Icon: Laptop },
  { value: "other", label: "Something else", Icon: MonitorSmartphone },
];

const NO_STEPS_TYPES = new Set(["iphone", "mac", "chromebook", "other"]);

function DeviceTypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = TYPE_OPTIONS.find((o) => o.value === type)?.Icon ?? MonitorSmartphone;
  return <Icon className={className} aria-hidden="true" />;
}

const addInitial: AddDeviceState = {};
const revokeInitial: RevokeDeviceState = {};
const deleteInitial: DeleteDeviceState = {};
const reportInitial: ReportIssueState = {};

export function DevicesView({ devices, startAdding = false }: { devices: DeviceItem[]; startAdding?: boolean }) {
  const [adding, setAdding] = useState(startAdding);

  return (
    <div className="flex flex-col gap-5">
      {adding ? (
        <AddFlow onClose={() => setAdding(false)} />
      ) : (
        <Button type="button" size="lg" className="w-full sm:w-auto sm:self-start" onClick={() => setAdding(true)}>
          <Plus className="h-5 w-5" aria-hidden="true" />
          Add a device
        </Button>
      )}

      {devices.length === 0 ? (
        !adding && (
          <EmptyState
            title="No devices yet"
            description="Add your phone or laptop to print from its normal Print button."
            icon={Smartphone}
          />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {devices.map((d) => (
            <DeviceRowItem key={d.id} device={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Small "Step 1 of 2" marker: this really is a two-step flow. */
function StepMarker({ step, title }: { step: 1 | 2; title: string }) {
  return (
    <div>
      <p className="text-[13px] font-medium text-[var(--color-primary)]">Step {step} of 2</p>
      <div className="mt-1.5 flex gap-1.5" aria-hidden="true">
        <span className="h-1 w-10 rounded-full bg-[var(--color-primary)]" />
        <span className={`h-1 w-10 rounded-full ${step === 2 ? "bg-[var(--color-primary)]" : "bg-[var(--color-border-strong)]"}`} />
      </div>
      <h2 className="mt-2 text-xl font-semibold leading-7">{title}</h2>
    </div>
  );
}

/** Form, then (after success) the one-time address. Unmounting it discards the address from memory. */
function AddFlow({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(addDeviceAction, addInitial);
  const [type, setType] = useState("windows");
  const [guessed, setGuessed] = useState(false);
  // Pre-select the type from this browser; the person can still change it.
  useEffect(() => {
    setType(detectDeviceType(navigator.userAgent, navigator.maxTouchPoints));
    setGuessed(true);
  }, []);
  if (state.created) return <AddressCard created={state.created} onDone={onClose} />;

  return (
    <Card className="sm:p-6">
      <form action={formAction} className="flex flex-col gap-5" aria-busy={pending}>
        <StepMarker step={1} title="What are you adding?" />
        <fieldset disabled={pending} className="min-w-0">
          <legend className="sr-only">What kind of device is it?</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {TYPE_OPTIONS.map((o) => (
              <label
                key={o.value}
                className="flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border-2 border-[var(--color-border)] p-3 text-sm font-medium transition-colors hover:border-[var(--color-border-strong)] has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--color-primary-soft)]/60 has-[:focus-visible]:shadow-[var(--ring)] has-[:disabled]:opacity-60"
              >
                <input type="radio" name="deviceType" value={o.value} checked={type === o.value} onChange={() => setType(o.value)} className="sr-only" />
                <o.Icon className="h-5 w-5 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
                <span className="min-w-0">{o.label}</span>
              </label>
            ))}
          </div>
          {guessed && <p className="mt-2 text-[13px] text-[var(--color-muted)]">We picked the one that matches this device. Change it if you are adding a different one.</p>}
          {NO_STEPS_TYPES.has(type) && <p className="mt-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-sm">{noStepsMessage(type)}</p>}
          <FieldError message={state.fieldErrors?.deviceType} />
        </fieldset>
        <Field label="Give it a name" hint="(so you can tell your devices apart)" htmlFor="name" error={state.fieldErrors?.name}>
          <Input
            id="name"
            name="name"
            autoFocus
            placeholder="For example: My Pixel"
            maxLength={80}
            disabled={pending}
            invalid={!!state.fieldErrors?.name}
            aria-describedby="name-desc"
            autoComplete="off"
          />
        </Field>
        {!state.fieldErrors && <FormError message={state.error} />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" pending={pending} pendingLabel="Creating address...">
            Create address
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant={copied ? "success" : "primary"} onClick={copy} className="w-full sm:w-auto">
        {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {copied ? "Copied" : label}
      </Button>
      {failed && <p className="text-xs text-[var(--color-danger)]">Could not copy. Select the text above and copy it by hand.</p>}
    </div>
  );
}

function AddressCard({ created, onDone }: { created: NonNullable<AddDeviceState["created"]>; onDone: () => void }) {
  const addr = deviceAddress(created.hostname);
  const guide = setupSteps(created.deviceType, addr);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const urlBlock = <AddressBlock title="Full address (Windows needs this one)" value={addr.url} copyLabel="Copy full address" highlight={guide?.needs === "url"} />;
  const hostBlock = (
    <AddressBlock title="Hostname only (Android needs this one)" value={addr.hostname} copyLabel="Copy hostname" highlight={guide?.needs === "hostname"} />
  );

  return (
    <Card className="flex flex-col gap-5 sm:p-6">
      <div>
        <p className="text-[13px] font-medium text-[var(--color-primary)]">Step 2 of 2</p>
        <div className="mt-1.5 flex gap-1.5" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-[var(--color-primary)]" />
          <span className="h-1 w-10 rounded-full bg-[var(--color-primary)]" />
        </div>
        <h2 ref={headingRef} tabIndex={-1} className="mt-2 break-words text-xl font-semibold leading-7 outline-none">
          Copy the address for {created.name}
        </h2>
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning-ink)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Copy it now. For your security we show it only once. If you lose it, turn this device off and add it again.
          </span>
        </p>
      </div>

      {guide?.needs === "hostname" ? (
        <>
          {hostBlock}
          {urlBlock}
        </>
      ) : (
        <>
          {urlBlock}
          {hostBlock}
        </>
      )}

      {guide ? (
        <div>
          <h3 className="mb-3 text-base font-semibold">Then, on your {deviceTypeLabel(created.deviceType)}</h3>
          {guide.note && <p className="mb-3 rounded-xl bg-[var(--color-surface-2)] p-3 text-sm font-medium">{guide.note}</p>}
          <ol className="flex flex-col gap-3">
            {guide.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-xs font-semibold text-[var(--color-primary)]"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 break-words text-sm leading-6">{s}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">
          {noStepsMessage(created.deviceType)}
        </p>
      )}

      <Button type="button" variant="secondary" size="lg" onClick={onDone}>
        I have copied it
      </Button>
    </Card>
  );
}

function AddressBlock({ title, value, copyLabel, highlight }: { title: string; value: string; copyLabel: string; highlight: boolean }) {
  return (
    <div className={`rounded-xl border-2 p-3.5 ${highlight ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]/40" : "border-[var(--color-border)]"}`}>
      <p className="mb-1 text-[13px] font-medium text-[var(--color-muted)]">{title}</p>
      <p className="mb-3 break-all font-mono text-sm leading-6">{value}</p>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

/** The status word for the right of a closed row: short, so the name keeps its room on a phone. */
const SHORT_STATUS: Record<string, string> = { revoked: "Off", created: "Not connected", connected: "Connected", job_received: "First print", printed: "Printed" };

function statusTone(tone: "neutral" | "success" | "warning"): StatusTone {
  return tone;
}

function DeviceRowItem({ device }: { device: DeviceItem }) {
  const status = deviceStatus(device);
  const revoked = status.key === "revoked";
  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [state, formAction, pending] = useActionState(revokeDeviceAction, revokeInitial);
  const hasIssue = !revoked && (device.open_issues ?? 0) > 0;

  return (
    <li className={revoked ? "opacity-70" : ""}>
      <Collapsible
        id={`device-${device.id}`}
        title={device.name}
        icon={<DeviceTypeIcon type={device.device_type} className="h-4 w-4" />}
        summary={
          <>
            {deviceTypeLabel(device.device_type)}
            {hasIssue ? " · problem reported" : ""}
          </>
        }
        badge={<StatusDot tone={statusTone(status.tone)}>{SHORT_STATUS[status.key] ?? status.label}</StatusDot>}
        headingLevel={3}
      >
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-[13px] text-[var(--color-muted)]">Added</dt>
              <dd className="mt-0.5 font-medium">
                <LocalTime iso={device.created_at} mode="date" />
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[13px] text-[var(--color-muted)]">Status</dt>
              <dd className="mt-0.5 font-medium">{status.label}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-[var(--color-muted)]">Last seen</dt>
              <dd className="mt-0.5 font-medium">{device.last_seen_at ? <LocalTime iso={device.last_seen_at} /> : "Not yet"}</dd>
            </div>
          </dl>

          {hasIssue && !reporting && (
            <p className="rounded-xl bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning-ink)]">
              You told us about a problem with this device. Your administrator will look at it.
            </p>
          )}
          {!revoked && reporting && <ReportIssueForm deviceId={device.id} onClose={() => setReporting(false)} />}
          {deleting && <DeleteDeviceForm deviceId={device.id} onClose={() => setDeleting(false)} />}
          {revoked && !deleting && (
            <div>
              <Button type="button" size="sm" variant="outline-danger" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            </div>
          )}
          {!revoked && !reporting && !deleting && (
            <div>
              {confirming ? (
                <form
                  action={formAction}
                  className="flex flex-col gap-3 rounded-xl bg-[var(--color-danger-soft)] p-3"
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && !pending) setConfirming(false);
                  }}
                >
                  <input type="hidden" name="deviceId" value={device.id} />
                  <p className="text-sm text-[var(--color-danger-ink)]">Turn off this device? Its address will stop working and it can no longer print.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" variant="danger" autoFocus pending={pending} pendingLabel="Turning off...">
                      Yes, turn off
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
                      Keep it
                    </Button>
                  </div>
                  <FormError message={state.error} />
                </form>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => setReporting(true)}>
                    I&apos;m having trouble
                  </Button>
                  <Button type="button" size="sm" variant="outline-danger" onClick={() => setConfirming(true)}>
                    Turn off
                  </Button>
                  <Button type="button" size="sm" variant="outline-danger" onClick={() => setDeleting(true)}>
                    Delete
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Collapsible>
    </li>
  );
}

/** Inline confirm for a permanent delete. Escape cancels; the row disappears when the page data refreshes. */
function DeleteDeviceForm({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(deleteDeviceAction, deleteInitial);
  return (
    <form
      action={formAction}
      aria-busy={pending}
      className="flex flex-col gap-3 rounded-xl bg-[var(--color-danger-soft)] p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) onClose();
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <p className="text-sm text-[var(--color-danger-ink)]">Delete this device? Its address stops working. Your print history stays.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" autoFocus pending={pending} pendingLabel="Deleting...">
          Yes, delete
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onClose}>
          Keep it
        </Button>
      </div>
      <FormError message={state.error} />
    </form>
  );
}

/** Pick what went wrong, add an optional note. On success shows a plain confirmation until closed. */
function ReportIssueForm({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(reportIssueAction, reportInitial);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.reportedId) doneRef.current?.focus();
  }, [state.reportedId]);

  if (state.reportedId) {
    return (
      <div className="flex flex-col gap-2">
        <div ref={doneRef} tabIndex={-1} className="outline-none">
          <FormSuccess message="Thanks, we got it. Your administrator will take a look." />
        </div>
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const fieldId = `issue-${deviceId}`;
  return (
    <form
      action={formAction}
      aria-busy={pending}
      className="flex flex-col gap-4"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) onClose();
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <fieldset disabled={pending} className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">What went wrong?</legend>
        {ISSUE_KINDS.map((k, i) => (
          <label key={k} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="radio" name="kind" value={k} autoFocus={i === 0} className="h-5 w-5 accent-[var(--color-primary)]" />
            <span>{issueKindLabel(k)}</span>
          </label>
        ))}
        <FieldError message={state.fieldErrors?.kind} />
      </fieldset>
      <div>
        <FieldLabel htmlFor={fieldId} hint="(optional)">
          Anything else we should know?
        </FieldLabel>
        <Textarea id={fieldId} name="note" rows={3} maxLength={MAX_ISSUE_NOTE} disabled={pending} className="font-sans" invalid={!!state.fieldErrors?.note} />
        <FieldError message={state.fieldErrors?.note} />
      </div>
      {!state.fieldErrors && <FormError message={state.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" pending={pending} pendingLabel="Sending...">
          Send
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
