"use client";

import { useActionState } from "react";
import { UserPlus } from "lucide-react";
import { Button, Input, FieldLabel, FormError, FormSuccess, Card } from "@/components/ui";
import { promoteSuperAdminAction, demoteSuperAdminAction, initialSuperAdminActionState } from "./actions";

export interface SuperAdminListItem {
  userId: string;
  email: string;
  displayName: string | null;
}

export function SuperAdminsPanel({
  currentUserId,
  superAdmins,
}: {
  currentUserId: string;
  superAdmins: SuperAdminListItem[];
}) {
  const [promoteState, promoteFormAction, promotePending] = useActionState(
    promoteSuperAdminAction,
    initialSuperAdminActionState,
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-[var(--color-muted)]" />
          <h2 className="text-sm font-semibold">Promote by email</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          The account must have signed in at least once already - this promotes an existing profile, it doesn&apos;t
          create one.
        </p>
        <form action={promoteFormAction} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" name="email" type="email" required placeholder="admin@example.com" />
          </div>
          <Button type="submit" size="sm" pending={promotePending} pendingLabel="Promoting...">
            Promote
          </Button>
        </form>
        <div className="mt-2">
          <FormError message={promoteState.error} />
          <FormSuccess message={promoteState.success} />
        </div>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-medium">Current super admins</h2>
        <ul className="flex flex-col gap-2">
          {superAdmins.map((admin) => (
            <SuperAdminRow key={admin.userId} admin={admin} isSelf={admin.userId === currentUserId} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SuperAdminRow({ admin, isSelf }: { admin: SuperAdminListItem; isSelf: boolean }) {
  const [state, formAction, pending] = useActionState(demoteSuperAdminAction, initialSuperAdminActionState);

  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {admin.displayName ?? admin.email}
            {isSelf && <span className="ml-1.5 text-xs font-normal text-[var(--color-muted)]">(you)</span>}
          </p>
          <p className="text-xs text-[var(--color-muted)]">{admin.email}</p>
        </div>
        <form action={formAction}>
          <input type="hidden" name="userId" value={admin.userId} />
          <Button
            type="submit"
            size="sm"
            variant="outline-danger"
            disabled={isSelf}
            pending={pending}
            pendingLabel="Removing..."
            title={isSelf ? "You can't remove your own super-admin access." : undefined}
          >
            Remove super admin
          </Button>
        </form>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </li>
  );
}
