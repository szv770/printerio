"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Check, Copy, Monitor, Smartphone } from "lucide-react";
import { Badge, Button, Card, EmptyState, FieldLabel, FormError, Input, Select, Textarea } from "@/components/ui";
import { ISSUE_KINDS, issueKindLabel, MAX_ISSUE_NOTE } from "@/lib/devices/admin";
import { deviceAddress, deviceStatus, deviceTypeLabel, setupSteps } from "@/lib/devices/present";
import { addDeviceAction, deleteDeviceAction, reportIssueAction, revokeDeviceAction, type AddDeviceState, type DeleteDeviceState, type ReportIssueState, type RevokeDeviceState } from "./actions";

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

const TYPE_OPTIONS = [
  { value: "windows", label: "Windows 11" },
  { value: "android", label: "Android (Pixel)" },
  { value: "chromebook", label: "Chromebook" },
  { value: "iphone", label: "iPhone / iPad" },
  { value: "mac", label: "Mac" },
  { value: "other", label: "Something else" },
];

const addInitial: AddDeviceState = {};
const revokeInitial: RevokeDeviceState = {};
const deleteInitial: DeleteDeviceState = {};
const reportInitial: ReportIssueState = {};

export function DevicesView({ devices }: { devices: DeviceItem[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      {adding ? (
        <AddFlow onClose={() => setAdding(false)} />
      ) : (
        <div>
          <Button type="button" onClick={() => setAdding(true)}>
            Add a device
          </Button>
        </div>
      )}

      {devices.length === 0 ? (
        <EmptyState message="No devices yet. Add one to print from your phone or laptop." icon={Smartphone} />
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

/** Form, then (after success) the one-time address. Unmounting it discards the address from memory. */
function AddFlow({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(addDeviceAction, addInitial);
  if (state.created) return <AddressCard created={state.created} onDone={onClose} />;

  return (
    <Card>
      <form action={formAction} className="flex flex-col gap-4" aria-busy={pending}>
        <h2 className="text-base font-semibold">Add a device</h2>
        <div>
          <FieldLabel htmlFor="deviceType">What kind of device is it?</FieldLabel>
          <Select id="deviceType" name="deviceType" defaultValue="windows" disabled={pending} aria-invalid={!!state.fieldErrors?.deviceType}>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="min-h-5">
            <FormError message={state.fieldErrors?.deviceType} />
          </div>
        </div>
        <div>
          <FieldLabel htmlFor="name" hint="(so you can tell your devices apart)">
            Name
          </FieldLabel>
          <Input
            id="name"
            name="name"
            autoFocus
            placeholder="e.g. My Pixel"
            maxLength={80}
            disabled={pending}
            aria-invalid={!!state.fieldErrors?.name}
            autoComplete="off"
          />
          <div className="min-h-5">
            <FormError message={state.fieldErrors?.name} />
          </div>
        </div>
        <div className="min-h-5">{!state.fieldErrors && <FormError message={state.error} />}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" pending={pending} pendingLabel="Creating address...">
            Create address
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
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
      <Button type="button" onClick={copy} className="inline-flex w-full items-center justify-center gap-2 sm:w-auto">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
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
    <Card className="flex flex-col gap-4">
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="break-words text-base font-semibold outline-none">
          {created.name} is ready
        </h2>
        <p role="alert" className="mt-2 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-900">
          Copy your address now. For your security we only show it once and cannot show it again. If you lose it, turn this device off and add it
          again.
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
          <h3 className="mb-2 text-sm font-semibold">Steps for {deviceTypeLabel(created.deviceType)}</h3>
          {guide.note && <p className="mb-2 text-sm font-medium">{guide.note}</p>}
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {guide.steps.map((s, i) => (
              <li key={i} className="break-words">
                {s}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">
          Step-by-step help for {deviceTypeLabel(created.deviceType)} is coming soon. Ask your administrator for help adding it.
        </p>
      )}

      <div>
        <Button type="button" variant="outline" onClick={onDone}>
          I have copied it
        </Button>
      </div>
    </Card>
  );
}

function AddressBlock({ title, value, copyLabel, highlight }: { title: string; value: string; copyLabel: string; highlight: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-2 border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>
      <p className="mb-1 text-xs font-medium text-[var(--color-muted)]">{title}</p>
      <p className="mb-3 break-all font-mono text-sm">{value}</p>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

function DeviceRowItem({ device }: { device: DeviceItem }) {
  const status = deviceStatus(device);
  const revoked = status.key === "revoked";
  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [state, formAction, pending] = useActionState(revokeDeviceAction, revokeInitial);
  const Icon = device.device_type === "android" || device.device_type === "iphone" ? Smartphone : Monitor;
  const added = new Date(device.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <li className={revoked ? "opacity-60" : ""}>
      <Card className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-muted)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className={`break-words font-medium ${revoked ? "line-through" : ""}`}>{device.name}</p>
            <p className="text-sm text-[var(--color-muted)]">
              {deviceTypeLabel(device.device_type)} · Added {added}
            </p>
          </div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        {!revoked && (device.open_issues ?? 0) > 0 && !reporting && (
          <p className="rounded-lg bg-yellow-50 p-2 text-sm text-yellow-900">You told us about a problem with this device. Your administrator will look at it.</p>
        )}
        {!revoked && reporting && <ReportIssueForm deviceId={device.id} onClose={() => setReporting(false)} />}
        {deleting && <DeleteDeviceForm deviceId={device.id} onClose={() => setDeleting(false)} />}
        {revoked && !deleting && (
          <div className="min-h-9">
            <Button type="button" size="sm" variant="outline-danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
        )}
        {!revoked && !reporting && !deleting && (
          <div className="min-h-9">
            {confirming ? (
              <form
                action={formAction}
                className="flex flex-col gap-2"
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !pending) setConfirming(false);
                }}
              >
                <input type="hidden" name="deviceId" value={device.id} />
                <p className="text-sm">Turn off this device? Its address will stop working and it can no longer print.</p>
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
                <Button type="button" size="sm" variant="outline" onClick={() => setReporting(true)}>
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
      </Card>
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
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) onClose();
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <p className="text-sm">Delete this device? This removes the device and its address stops working. Your print history stays.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" autoFocus pending={pending} pendingLabel="Deleting...">
          Yes, delete
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onClose}>
          Keep it
        </Button>
      </div>
      <div className="min-h-5">
        <FormError message={state.error} />
      </div>
    </form>
  );
}

/** Pick what went wrong, add an optional note. On success shows a plain confirmation until closed. */
function ReportIssueForm({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(reportIssueAction, reportInitial);
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.reportedId) doneRef.current?.focus();
  }, [state.reportedId]);

  if (state.reportedId) {
    return (
      <div className="flex flex-col gap-2">
        <p ref={doneRef} tabIndex={-1} role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-900 outline-none">
          Thanks, we got it. Your administrator will take a look.
        </p>
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
      className="flex flex-col gap-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) onClose();
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <fieldset disabled={pending} className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">What went wrong?</legend>
        {ISSUE_KINDS.map((k, i) => (
          <label key={k} className="flex items-start gap-2 text-sm">
            <input type="radio" name="kind" value={k} autoFocus={i === 0} className="mt-1" />
            <span>{issueKindLabel(k)}</span>
          </label>
        ))}
        <div className="min-h-5">
          <FormError message={state.fieldErrors?.kind} />
        </div>
      </fieldset>
      <div>
        <FieldLabel htmlFor={fieldId} hint="(optional)">
          Anything else we should know?
        </FieldLabel>
        <Textarea id={fieldId} name="note" rows={3} maxLength={MAX_ISSUE_NOTE} disabled={pending} className="font-sans" aria-invalid={!!state.fieldErrors?.note} />
        <div className="min-h-5">
          <FormError message={state.fieldErrors?.note} />
        </div>
      </div>
      <div className="min-h-5">{!state.fieldErrors && <FormError message={state.error} />}</div>
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
