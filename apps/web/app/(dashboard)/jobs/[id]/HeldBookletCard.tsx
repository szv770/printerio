"use client";

import { useActionState, useState } from "react";
import { Button, FormError, Segmented } from "@/components/ui";
import { finishHeldBookletAction, type SubmitJobState } from "../../print/actions";

const initialState: SubmitJobState = {};

/**
 * One-tap finish for a booklet that came from the print dialog (which cannot say left or right binding).
 * Nothing is pre-selected on purpose: the member must pick an edge, then confirm with the Print button.
 * The action creates the real job from the stored original and closes this held one.
 */
export function HeldBookletCard({ jobId, reason }: { jobId: string; reason: string | null }) {
  const [state, formAction, pending] = useActionState(finishHeldBookletAction, initialState);
  const [side, setSide] = useState<"" | "left" | "right">("");

  return (
    <form action={formAction} className="mt-3 rounded-lg border border-[var(--color-border)] p-3">
      <input type="hidden" name="jobId" value={jobId} />
      <p className="text-sm font-medium">{reason?.trim() || "Booklet: choose left or right binding."}</p>
      <div className="mt-3">
        <Segmented
          name="bindingSide"
          label="Which edge is the booklet bound on?"
          value={side}
          onChange={setSide}
          disabled={pending}
          options={[
            { value: "left", label: "Left binding" },
            { value: "right", label: "Right binding" },
          ]}
          hint="Left is the usual choice for English. Right is for right-to-left languages such as Hebrew."
        />
      </div>
      <div className="mt-3">
        <Button type="submit" pending={pending} pendingLabel="Printing..." disabled={side === ""}>
          {side === "" ? "Choose a side to print" : `Print booklet, ${side} binding`}
        </Button>
      </div>
      <div className="mt-2">
        <FormError message={state.error} />
      </div>
    </form>
  );
}
