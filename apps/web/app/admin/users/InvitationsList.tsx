"use client";

import { useActionState } from "react";
import { roleLabel } from "@/lib/role-label";
import { Button, FormError } from "@/components/ui";
import { inviteStatus, type InviteStatus } from "@/lib/auth/invite-link";
import { revokeInvitationAction, type RevokeInvitationState } from "./actions";
import { CopyCodeButton } from "./CopyCodeButton";
import { CopyLinkButton, ShareInviteButton } from "./ShareInviteButton";

export interface OpenInvitation {
  id: string;
  code: string | null;
  role: string;
  usesCount: number;
  maxUses: number | null;
  expiresAt: string | null;
}

const initialState: RevokeInvitationState = {};

/** One-line plain description of how an invite has been used so far. */
export function invitationNote(inv: OpenInvitation): string {
  const used = inv.maxUses ? `Used ${inv.usesCount} of ${inv.maxUses}` : `Used ${inv.usesCount} ${inv.usesCount === 1 ? "time" : "times"}`;
  const ends = inv.expiresAt ? `, stops working ${new Date(inv.expiresAt).toLocaleDateString()}` : "";
  return `Joins as ${roleLabel(inv.role)}. ${used}${ends}.`;
}

const STATUS_STYLE: Record<InviteStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-[var(--color-success-soft)] text-[var(--color-success-ink)]" },
  used: { label: "Used up", cls: "bg-[var(--color-surface-2)] text-[var(--color-muted)]" },
  expired: { label: "Expired", cls: "bg-[var(--color-surface-2)] text-[var(--color-muted)]" },
};

export function InvitationsList({ invitations, orgName }: { invitations: OpenInvitation[]; orgName: string }) {
  return (
    <ul className="flex flex-col gap-3">
      {invitations.map((invitation) => (
        <InvitationRow key={invitation.id} invitation={invitation} orgName={orgName} />
      ))}
    </ul>
  );
}

function InvitationRow({ invitation, orgName }: { invitation: OpenInvitation; orgName: string }) {
  const [state, action, pending] = useActionState(revokeInvitationAction, initialState);
  const status = inviteStatus(invitation);
  const style = STATUS_STYLE[status];
  const active = status === "active";

  return (
    <li
      className={`flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3.5 ${active ? "" : "opacity-80"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-md bg-[var(--color-surface)] px-2.5 py-1 font-mono text-base font-semibold tracking-widest break-all shadow-[var(--shadow-xs)]">
          {invitation.code}
        </code>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.cls}`}>{style.label}</span>
      </div>
      <p className="text-[13px] text-[var(--color-muted)]">{invitationNote(invitation)}</p>
      <div className="flex flex-wrap items-start gap-2">
        {active && invitation.code && (
          <>
            <ShareInviteButton code={invitation.code} orgName={orgName} />
            <CopyLinkButton code={invitation.code} />
            <CopyCodeButton code={invitation.code} />
          </>
        )}
        <form
          action={action}
          className="sm:ml-auto"
          onSubmit={(e) => {
            const msg = active
              ? "Turn off this invite? The link and code will stop working right away."
              : "Remove this invite from the list?";
            if (!confirm(msg)) e.preventDefault();
          }}
        >
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button type="submit" variant="outline-danger" size="sm" pending={pending} pendingLabel="Working...">
            {active ? "Turn off" : "Remove"}
          </Button>
        </form>
      </div>
      <FormError message={state.error} />
    </li>
  );
}
