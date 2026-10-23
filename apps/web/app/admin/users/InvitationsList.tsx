"use client";

import { useActionState } from "react";
import { roleLabel } from "@/lib/role-label";
import { Button, FormError } from "@/components/ui";
import { revokeInvitationAction, type RevokeInvitationState } from "./actions";
import { CopyCodeButton } from "./CopyCodeButton";

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

export function InvitationsList({ invitations }: { invitations: OpenInvitation[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {invitations.map((invitation) => (
        <InvitationRow key={invitation.id} invitation={invitation} />
      ))}
    </ul>
  );
}

function InvitationRow({ invitation }: { invitation: OpenInvitation }) {
  const [state, action, pending] = useActionState(revokeInvitationAction, initialState);

  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md bg-[var(--color-surface)] px-2.5 py-1 font-mono text-base font-semibold tracking-widest break-all shadow-[var(--shadow-xs)]">
            {invitation.code}
          </code>
          {invitation.code && <CopyCodeButton code={invitation.code} />}
        </div>
        <p className="mt-2 text-[13px] text-[var(--color-muted)]">{invitationNote(invitation)}</p>
      </div>
      <div className="shrink-0">
        <form
          action={action}
          onSubmit={(e) => {
            if (!confirm("Turn off this invite code? It will stop working right away.")) e.preventDefault();
          }}
        >
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button type="submit" variant="outline-danger" size="sm" pending={pending} pendingLabel="Turning off..." className="w-full sm:w-auto">
            Turn off
          </Button>
        </form>
        <FormError message={state.error} />
      </div>
    </li>
  );
}
