"use client";

import { useActionState } from "react";
import { BadgeCheck, FlaskConical, ThumbsUp, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, FormError } from "@/components/ui";
import { setSetupConfirmedAction, type SetupConfirmState } from "./actions";
import type { SetupSummary } from "@/lib/devices/setup-feedback";

const initial: SetupConfirmState = {};

const STATUS_TONE = { confirmed: "success", reported: "accent", not_tested: "neutral" } as const;

/** Per device type + setup method: what people reported, and the admin's "Confirmed working" mark. */
export function SetupStatusPanel({ setups, canConfirm }: { setups: SetupSummary[]; canConfirm: boolean }) {
  return (
    <section aria-labelledby="setup-status-title" className="mb-6">
      <h2 id="setup-status-title" className="text-lg font-semibold tracking-[-0.01em]">
        Does each way of adding a device work?
      </h2>
      <p className="mt-1 mb-3 text-sm text-[var(--color-muted)]">
        After a person&apos;s first print, we ask if it came out OK. Their answers are counted here for each way of setting up. When you have
        tried one yourself, mark it Confirmed working.
      </p>
      <ul className="flex flex-col gap-3">
        {setups.map((s) => (
          <SetupRow key={s.key} setup={s} canConfirm={canConfirm} />
        ))}
      </ul>
    </section>
  );
}

function SetupRow({ setup, canConfirm }: { setup: SetupSummary; canConfirm: boolean }) {
  const [state, action, pending] = useActionState(setSetupConfirmedAction, initial);
  const StatusIcon = setup.status === "confirmed" ? BadgeCheck : setup.status === "reported" ? ThumbsUp : FlaskConical;
  // Only the setups we wrote steps for can be confirmed (the server checks this too).
  const confirmable = !setup.key.startsWith("other_");
  return (
    <li>
      <Card className="flex flex-col gap-3 !p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="text-[15px] leading-6 font-semibold break-words">{setup.label}</p>
            <p className="mt-1 flex items-center gap-2 text-sm">
              <Badge tone={STATUS_TONE[setup.status]}>
                <StatusIcon className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {setup.statusLabel}
              </Badge>
            </p>
          </div>
          {canConfirm && confirmable && (
            <form action={action} className="shrink-0">
              <input type="hidden" name="setupKey" value={setup.key} />
              <input type="hidden" name="confirmed" value={setup.confirmed ? "0" : "1"} />
              <Button type="submit" size="sm" variant={setup.confirmed ? "outline" : "primary"} pending={pending} pendingLabel="Saving...">
                {setup.confirmed ? "Remove confirmation" : "Mark as Confirmed working"}
              </Button>
            </form>
          )}
        </div>
        <p className="text-[13px] text-[var(--color-muted)]">
          {setup.worked} {setup.worked === 1 ? "person says" : "people say"} it worked
          {setup.problems > 0 ? `, ${setup.problems} reported ${setup.problems === 1 ? "a problem" : "problems"}` : ""}.
        </p>
        {setup.problemNotes.length > 0 && (
          <div className="rounded-xl bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning-ink)]">
            <p className="mb-1 flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              What people said went wrong
            </p>
            <ul className="list-disc pl-5">
              {setup.problemNotes.slice(0, 5).map((n, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  {n}
                </li>
              ))}
            </ul>
            {setup.problemNotes.length > 5 && <p className="mt-1 text-[13px]">and {setup.problemNotes.length - 5} more</p>}
          </div>
        )}
        <FormError message={state.error} />
      </Card>
    </li>
  );
}
