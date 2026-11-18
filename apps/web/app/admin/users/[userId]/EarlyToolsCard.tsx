"use client";

import { useActionState } from "react";
import { FlaskConical } from "lucide-react";
import { Badge, Button, Card, FormError } from "@/components/ui";
import { setMemberEarlyToolsAction, type EarlyToolsState } from "../actions";

const initial: EarlyToolsState = {};

/** Lets an admin share the early tools (print from a link, build a booklet from several files) with one person. */
export function EarlyToolsCard({ userId, isAdmin, enabled, firstName, canEdit }: { userId: string; isAdmin: boolean; enabled: boolean; firstName: string; canEdit: boolean }) {
  const [state, action, pending] = useActionState(setMemberEarlyToolsAction, initial);
  const on = isAdmin || enabled;
  return (
    <Card className="mb-4">
      <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
        <FlaskConical className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
        Early tools
        <Badge tone={on ? "success" : "neutral"}>{on ? "On" : "Off"}</Badge>
      </h2>
      <p className="text-[13px] text-[var(--color-muted)]">
        {isAdmin
          ? "Admins always have these."
          : `Print from a link and make a booklet from several files. Still being tested, so they are off unless you switch them on for ${firstName}.`}
      </p>
      {canEdit && !isAdmin && (
        <form action={action} className="mt-3">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <Button type="submit" variant="secondary" size="sm" pending={pending} pendingLabel="Saving...">
            {enabled ? `Turn off for ${firstName}` : `Turn on for ${firstName}`}
          </Button>
          <FormError message={state.error} />
        </form>
      )}
    </Card>
  );
}
