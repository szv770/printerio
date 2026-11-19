"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import { Badge, Button, Card, FormError, Skeleton } from "@/components/ui";
import { useMounted } from "@/components/ui/Modal";
import { routes } from "@/lib/routes";
import { roleLabel } from "@/lib/role-label";
import type { PersonRow } from "@/lib/admin/people-query";
import { ACTIVITY_WINDOW_DAYS, type PersonDetail } from "@/lib/admin/person-detail";
import { MemberDetailControls } from "./[userId]/MemberDetailControls";
import { MemberAccessCard } from "./[userId]/MemberAccessCard";
import { EarlyToolsCard } from "./[userId]/EarlyToolsCard";
import { CancelQueueCard } from "./[userId]/CancelQueueCard";

export function initials(name: string | null, email: string): string {
  const src = (name ?? email).trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The person drawer: a side panel on desktop, a full sheet on phones. The top comes from the list row (always current);
 * the body is loaded from the server when it opens (groups, what they can use, activity) and again whenever the row
 * changes, for example after a save. The editing controls are the existing ones, so they run the same server actions.
 */
export function PersonDrawer({
  row,
  canEdit,
  loadDetail,
  assignCode,
  onClose,
  readOnlyPreview = false,
}: {
  row: PersonRow;
  canEdit: boolean;
  loadDetail: (userId: string) => Promise<PersonDetail | null>;
  assignCode: (userId: string) => Promise<{ ok: boolean; message: string; code?: string }>;
  onClose: () => void;
  /** Dev preview only: the controls are shown but switched off, so nothing real can be called. */
  readOnlyPreview?: boolean;
}) {
  const mounted = useMounted();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<{ key: string; detail: PersonDetail | null; failed: boolean } | null>(null);
  const [codeMessage, setCodeMessage] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  // Reload when the person changes or their row changes (a save elsewhere revalidates the list).
  const rowKey = [row.userId, row.role, row.status, row.department ?? "", row.userCode ?? ""].join("|");
  useEffect(() => {
    let cancelled = false;
    loadDetail(row.userId)
      .then((detail) => {
        if (!cancelled) setState({ key: rowKey, detail, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ key: rowKey, detail: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [row.userId, rowKey, loadDetail]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  if (!mounted) return null;
  const loading = state === null || state.detail?.userId !== row.userId;
  const detail = !loading ? state.detail : null;
  const name = row.displayName ?? row.email;
  const first = name.split(/[\s@]/)[0] ?? "this person";
  const active = row.status === "active";

  async function giveCode() {
    setAssigning(true);
    setCodeMessage(null);
    try {
      const res = await assignCode(row.userId);
      setCodeMessage(res.message);
    } catch {
      setCodeMessage("Could not assign a code right now.");
    }
    setAssigning(false);
  }

  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${name}, details`}
        className="absolute inset-y-0 right-0 flex w-full flex-col bg-[var(--color-bg)] shadow-[var(--shadow-pop)] sm:w-[30rem] sm:border-l sm:border-[var(--color-border)]"
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-5">
          <span
            aria-hidden="true"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
              active ? "bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]" : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
            }`}
          >
            {initials(row.displayName, row.email)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{name}</h2>
            {row.displayName && <p className="truncate text-[13px] text-[var(--color-muted)]">{row.email}</p>}
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge>{roleLabel(row.role)}</Badge>
              {row.department && <Badge tone="accent">{row.department}</Badge>}
              <Badge tone={active ? "success" : "neutral"}>{active ? "Active" : "Off"}</Badge>
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-5">
          {loading ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : !detail ? (
            <Card>
              <FormError message={state?.failed ? "Couldn't load this person. Close and try again." : "This person is no longer in this organization."} />
            </Card>
          ) : (
            <fieldset disabled={readOnlyPreview} className="min-w-0 border-0 p-0">
              <Card className="mb-4">
                <MemberDetailControls
                  key={rowKey}
                  member={{ userId: detail.userId, role: detail.role, status: detail.status, department: detail.department }}
                  canEdit={canEdit}
                  onRemoved={onClose}
                />
              </Card>

              <Card className="mb-4 text-sm">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                  <dt className="text-[var(--color-muted)]">Print code</dt>
                  <dd className="min-w-0 text-right">
                    {detail.userCode ? (
                      <code className="rounded-md bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs tracking-wider">{detail.userCode}</code>
                    ) : (
                      <span className="text-[var(--color-muted)]">
                        Not assigned yet
                        {canEdit && (
                          <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => void giveCode()} pending={assigning} pendingLabel="Assigning...">
                            Assign now
                          </Button>
                        )}
                      </span>
                    )}
                  </dd>
                  <dt className="text-[var(--color-muted)]">Joined</dt>
                  <dd className="text-right font-medium">{new Date(detail.joinedAt).toLocaleDateString()}</dd>
                  <dt className="text-[var(--color-muted)]">Print jobs (last {ACTIVITY_WINDOW_DAYS} days)</dt>
                  <dd className="text-right font-medium">{detail.jobCount}</dd>
                  <dt className="text-[var(--color-muted)]">Pages (last {ACTIVITY_WINDOW_DAYS} days)</dt>
                  <dd className="text-right font-medium">{detail.totalPages}</dd>
                </dl>
                {codeMessage && <p className="mt-2 text-[13px] text-[var(--color-muted)]">{codeMessage}</p>}
              </Card>

              <MemberAccessCard groups={detail.groups.map((g) => g.name)} access={detail.access} firstName={first} />
              <EarlyToolsCard userId={detail.userId} isAdmin={detail.role === "org_admin"} enabled={detail.earlyTools} canEdit={canEdit} firstName={first} />
              {canEdit && <CancelQueueCard userId={detail.userId} firstName={first} />}

              <Link
                href={routes.adminUserDetail(detail.userId)}
                className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--color-primary)] hover:underline"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Open the full page
              </Link>
            </fieldset>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
