"use client";

import { useActionState } from "react";
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

/** The client half of page.tsx's "Open invitations" list - split out just for
 *  the code+copy+revoke bit so the rest of the page can stay a plain Server
 *  Component. Previously an invitation's code was bare `<code>` text with no
 *  way to copy it, and no way to get rid of one created with the wrong role
 *  or that leaked short of deleting the row by hand in Postgres. */
export function InvitationsList({ invitations }: { invitations: OpenInvitation[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {invitations.map((invitation) => (
        <InvitationRow key={invitation.id} invitation={invitation} />
      ))}
    </ul>
  );
}

function InvitationRow({ invitation }: { invitation: OpenInvitation }) {
  const [state, action, pending] = useActionState(revokeInvitationAction, initialState);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-gray-100 px-2 py-1 font-mono">{invitation.code}</code>
        {invitation.code && <CopyCodeButton code={invitation.code} />}
        <span className="text-[var(--color-muted)]">
          role: {invitation.role} — used {invitation.usesCount}
          {invitation.maxUses ? `/${invitation.maxUses}` : ""} times
          {invitation.expiresAt ? ` — expires ${new Date(invitation.expiresAt).toLocaleDateString()}` : ""}
        </span>
      </div>
      <div>
        <form
          action={action}
          onSubmit={(e) => {
            if (!confirm("Revoke this invitation code? It will stop working immediately.")) e.preventDefault();
          }}
        >
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button type="submit" variant="outline-danger" size="sm" pending={pending} pendingLabel="Revoking...">
            Revoke
          </Button>
        </form>
        <FormError message={state.error} />
      </div>
    </li>
  );
}
