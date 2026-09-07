"use client";

import { useActionState } from "react";
import { LogIn } from "lucide-react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { joinOrganizationAsAdminAction, initialPlatformActionState } from "./actions";

/** One per organization row on the Overview page - only rendered for an
 *  organization the acting super_admin isn't already a member of (see
 *  app/platform/page.tsx, which pre-computes that from a single query rather
 *  than letting this button find out via a failed insert). */
export function JoinOrganizationButton({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const [state, formAction, pending] = useActionState(joinOrganizationAsAdminAction, initialPlatformActionState);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <Button type="submit" size="sm" variant="outline" pending={pending} pendingLabel="Joining...">
          <span className="flex items-center gap-1.5">
            <LogIn className="h-3.5 w-3.5" />
            Join as admin
          </span>
        </Button>
      </form>
      <div className="max-w-[16rem] text-right">
        <FormError message={state.error} />
        <FormSuccess message={state.success} />
      </div>
      <span className="sr-only">{organizationName}</span>
    </div>
  );
}
