"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Smartphone } from "lucide-react";
import { Badge, Button, Card, EmptyState, FieldLabel, FormError, Textarea } from "@/components/ui";
import { deviceStatus, deviceTypeLabel } from "@/lib/devices/present";
import { issueKindLabel, MAX_ISSUE_NOTE, STUCK_LABELS, type StuckReason } from "@/lib/devices/admin";
import { adminDeleteDeviceAction, adminRevokeDeviceAction, resolveIssueAction, type AdminDeleteState, type AdminRevokeState, type ResolveIssueState } from "./actions";
import { loadDeviceEventsAction, type DeviceEventItem } from "./events";

export interface AdminIssue {
  id: string;
  kind: string;
  note: string;
  status: string;
  created_at: string;
  resolved_note: string | null;
  resolved_at: string | null;
}

export interface AdminDevice {
  id: string;
  userName: string;
  name: string;
  device_type: string;
  created_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  first_job_at: string | null;
  first_printed_at: string | null;
  last_user_agent: string | null;
  stuck: StuckReason | null;
  issues: AdminIssue[];
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never";

export function DevicesAdmin({ devices }: { devices: AdminDevice[] }) {
  if (devices.length === 0) return <EmptyState message="No devices yet. They show up here when people add them." icon={Smartphone} />;
  return (
    <ul className="flex flex-col gap-3">
      {devices.map((d) => (
        <DeviceItem key={d.id} device={d} />
      ))}
    </ul>
  );
}

function DeviceItem({ device }: { device: AdminDevice }) {
  const [open, setOpen] = useState(false);
  const status = deviceStatus(device);
  const revoked = status.key === "revoked";
  const openIssues = device.issues.filter((i) => i.status === "open");
  const panelId = `device-${device.id}`;

  return (
    <li className={revoked ? "opacity-70" : ""}>
      <Card className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-start gap-3 rounded-lg text-left"
        >
          {open ? <ChevronDown className="mt-0.5 h-5 w-5 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className="block break-words font-medium">{device.userName}</span>
            <span className="block break-words text-sm text-[var(--color-muted)]">
              {device.name} · {deviceTypeLabel(device.device_type)}
            </span>
            <span className="mt-1 block text-xs text-[var(--color-muted)]">
              Last seen {fmt(device.last_seen_at)} · First print {device.first_job_at ? fmt(device.first_job_at) : "none yet"}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={status.tone}>{status.label}</Badge>
            {device.stuck && <Badge tone="warning">{STUCK_LABELS[device.stuck]}</Badge>}
            {openIssues.length > 0 && <Badge tone="warning">{openIssues.length} open</Badge>}
          </span>
        </button>

        {open && (
          <div id={panelId} className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-3">
            <IssuesList issues={device.issues} />
            <EventsLog deviceId={device.id} lastUserAgent={device.last_user_agent} />
            <div className="flex flex-col gap-3">
              {!revoked && <RevokeControl deviceId={device.id} />}
              <DeleteControl deviceId={device.id} />
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}

function IssuesList({ issues }: { issues: AdminIssue[] }) {
  if (issues.length === 0) return <p className="text-sm text-[var(--color-muted)]">No problems reported.</p>;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Problems reported</h3>
      <ul className="flex flex-col gap-3">
        {issues.map((i) => (
          <IssueItem key={i.id} issue={i} />
        ))}
      </ul>
    </div>
  );
}

const resolveInitial: ResolveIssueState = {};

function IssueItem({ issue }: { issue: AdminIssue }) {
  const [resolving, setResolving] = useState(false);
  const [state, formAction, pending] = useActionState(resolveIssueAction, resolveInitial);
  const isOpen = issue.status === "open" && !state.resolvedId;

  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{issueKindLabel(issue.kind)}</span>
        <span className="text-xs text-[var(--color-muted)]">{fmt(issue.created_at)}</span>
      </div>
      {issue.note && <p className="mt-1 whitespace-pre-wrap break-words">{issue.note}</p>}
      {!isOpen ? (
        <p className="mt-2 text-[var(--color-muted)]">
          Resolved{issue.resolved_at ? ` ${fmt(issue.resolved_at)}` : ""}
          {issue.resolved_note ? `: ${issue.resolved_note}` : "."}
        </p>
      ) : resolving ? (
        <form
          action={formAction}
          aria-busy={pending}
          className="mt-2 flex flex-col gap-2"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pending) setResolving(false);
          }}
        >
          <input type="hidden" name="issueId" value={issue.id} />
          <FieldLabel htmlFor={`resolve-${issue.id}`} hint="(optional)">
            What did you do?
          </FieldLabel>
          <Textarea id={`resolve-${issue.id}`} name="note" rows={2} maxLength={MAX_ISSUE_NOTE} autoFocus disabled={pending} className="font-sans" />
          <div className="min-h-5">
            <FormError message={state.error} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" pending={pending} pendingLabel="Saving...">
              Mark resolved
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setResolving(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setResolving(true)}>
            Resolve
          </Button>
        </div>
      )}
    </li>
  );
}

function eventLabel(type: string): string {
  switch (type) {
    case "attributes_requested":
      return "Device connected";
    case "job_received":
      return "Print received";
    case "job_rejected":
      return "Print refused";
    case "info":
      return "Note";
    default:
      return type;
  }
}

function EventsLog({ deviceId, lastUserAgent }: { deviceId: string; lastUserAgent: string | null }) {
  const [events, setEvents] = useState<DeviceEventItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    startLoad(async () => {
      const res = await loadDeviceEventsAction(deviceId);
      if (cancelled) return;
      if (res.error) setError(res.error);
      else {
        setError(null);
        setEvents(res.events ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, attempt]);

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">What this device sent</h3>
      {lastUserAgent && <p className="mb-2 break-all text-xs text-[var(--color-muted)]">Last seen as: {lastUserAgent}</p>}
      <div className="min-h-12" aria-busy={loading}>
        {error ? (
          <div className="flex flex-col items-start gap-2">
            <FormError message={error} />
            <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : events === null ? (
          <p className="text-sm text-[var(--color-muted)]">Loading...</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">Nothing yet.</p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto text-xs">
            {events.map((e) => (
              <li key={e.id} className="rounded-lg bg-[var(--color-surface)] p-2">
                <p className="font-medium">
                  {eventLabel(e.type)} <span className="font-normal text-[var(--color-muted)]">· {fmt(e.created_at)}</span>
                </p>
                {e.user_agent && <p className="break-all text-[var(--color-muted)]">{e.user_agent}</p>}
                {e.detail && <p className="break-all font-mono">{e.detail}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const revokeInitial: AdminRevokeState = {};

function RevokeControl({ deviceId }: { deviceId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(adminRevokeDeviceAction, revokeInitial);

  if (!confirming) {
    return (
      <div>
        <Button type="button" size="sm" variant="outline-danger" onClick={() => setConfirming(true)}>
          Turn off this device
        </Button>
      </div>
    );
  }
  return (
    <form
      action={formAction}
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) setConfirming(false);
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <p className="text-sm">Turn this device off? Its address stops working and it can no longer print. The user can add it again.</p>
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
  );
}

const deleteInitial: AdminDeleteState = {};

function DeleteControl({ deviceId }: { deviceId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(adminDeleteDeviceAction, deleteInitial);

  if (!confirming) {
    return (
      <div>
        <Button type="button" size="sm" variant="outline-danger" onClick={() => setConfirming(true)}>
          Delete device
        </Button>
      </div>
    );
  }
  return (
    <form
      action={formAction}
      aria-busy={pending}
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) setConfirming(false);
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <p className="text-sm">Delete this device? This removes the device and its address stops working. Print history stays.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" autoFocus pending={pending} pendingLabel="Deleting...">
          Yes, delete
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      <div className="min-h-5">
        <FormError message={state.error} />
      </div>
    </form>
  );
}
