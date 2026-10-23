"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { ChevronDown, Smartphone } from "lucide-react";
import { Badge, Button, EmptyState, FieldLabel, FormError, ResponsiveTable, StatusDot, Textarea, type TableColumn } from "@/components/ui";
import { deviceTone } from "@/lib/admin/summaries";
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
  const [openId, setOpenId] = useState<string | null>(null);
  if (devices.length === 0)
    return (
      <EmptyState
        title="No user devices yet"
        message="When people add their phone or laptop to print from it, it shows up here."
        icon={Smartphone}
      />
    );

  const needAttention = devices.filter((d) => d.issues.some((i) => i.status === "open") || d.stuck).length;
  const columns: TableColumn<AdminDevice>[] = [
    {
      header: "Person",
      primary: true,
      cell: (d) => {
        const open = openId === d.id;
        return (
          <button
            type="button"
            onClick={() => setOpenId(open ? null : d.id)}
            aria-expanded={open}
            aria-controls={`device-${d.id}`}
            className="flex min-h-11 w-full items-start gap-2 rounded-[var(--radius-control)] text-left focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
          >
            <ChevronDown
              className={`mt-1 h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform motion-reduce:transition-none ${open ? "rotate-180" : "-rotate-90"}`}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block break-words">{d.userName}</span>
              <span className="block text-[13px] font-normal break-words text-[var(--color-muted)]">
                {d.name}, {deviceTypeLabel(d.device_type)}
              </span>
            </span>
          </button>
        );
      },
    },
    {
      header: "Status",
      cell: (d) => {
        const status = deviceStatus(d);
        const openIssues = d.issues.filter((i) => i.status === "open").length;
        return (
          <span className="flex flex-col gap-1.5 sm:items-start">
            <StatusDot tone={deviceTone({ statusKey: status.key, openIssues, stuck: d.stuck })}>{status.label}</StatusDot>
            {openIssues > 0 && <Badge tone="danger">{openIssues === 1 ? "1 problem to look at" : `${openIssues} problems to look at`}</Badge>}
            {d.stuck && <Badge tone="warning">{STUCK_LABELS[d.stuck]}</Badge>}
          </span>
        );
      },
    },
    { header: "Last seen", cell: (d) => fmt(d.last_seen_at) },
    { header: "First print", cell: (d) => (d.first_job_at ? fmt(d.first_job_at) : "None yet") },
  ];

  return (
    <div>
      <p className="mb-3 text-[13px] text-[var(--color-muted)]" aria-live="polite">
        {devices.length} {devices.length === 1 ? "device" : "devices"}
        {needAttention > 0 ? `, ${needAttention} need a look` : ""}
      </p>
      <ResponsiveTable
        columns={columns}
        rows={devices}
        rowKey={(d) => d.id}
        caption="All devices"
        rowClassName={(d) =>
          d.issues.some((i) => i.status === "open")
            ? "bg-[var(--color-danger-soft)]/40 ring-1 ring-[var(--color-danger)]/30"
            : d.revoked_at
              ? "opacity-70"
              : ""
        }
        expanded={(d) => (openId === d.id ? <DeviceDetail device={d} /> : null)}
      />
    </div>
  );
}

function DeviceDetail({ device }: { device: AdminDevice }) {
  const revoked = deviceStatus(device).key === "revoked";
  return (
    <div id={`device-${device.id}`} className="mt-3 flex flex-col gap-5 border-t border-[var(--color-border)] pt-4 text-left font-normal">
      <IssuesList issues={device.issues} />
      <EventsLog deviceId={device.id} lastUserAgent={device.last_user_agent} />
      <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
        {!revoked && <RevokeControl deviceId={device.id} />}
        <DeleteControl deviceId={device.id} />
      </div>
    </div>
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
    <li className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 text-sm">
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
              <li key={e.id} className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)]/60 p-2.5">
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
