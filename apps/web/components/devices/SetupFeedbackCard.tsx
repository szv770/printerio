"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CircleCheck, Printer, ThumbsUp } from "lucide-react";
import { Button, Card, Field, FormError, Textarea } from "@/components/ui";
import { submitSetupFeedbackAction, type SetupFeedbackState } from "@/app/(dashboard)/devices/actions";
import { deviceTypeLabel } from "@/lib/devices/present";
import { FEEDBACK_NOTE_MAX } from "@/lib/devices/setup-feedback";

const initial: SetupFeedbackState = {};

export interface FeedbackCardItem {
  id: string;
  name: string;
  device_type: string;
}

/**
 * "Did it come out OK?" - shown once after the first print from a newly added device printed with no errors.
 * One device at a time; answering removes it. Yes is one tap; "Something was wrong" asks for a short note.
 */
export function SetupFeedbackCard({ devices }: { devices: FeedbackCardItem[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Once shown, a device stays in this card until the person presses Close: answering revalidates the page, which
  // drops the device from `devices`, and the thank-you message must not vanish with it.
  const [current, setCurrent] = useState<FeedbackCardItem | null>(null);
  const next = current ?? devices.find((d) => !dismissed.has(d.id)) ?? null;
  if (!next) return null;
  return (
    <FeedbackForm
      key={next.id}
      device={next}
      onShown={() => setCurrent((c) => c ?? next)}
      onAnswered={(id) => {
        setDismissed((s) => new Set(s).add(id));
        setCurrent(null);
      }}
    />
  );
}

function FeedbackForm({ device, onShown, onAnswered }: { device: FeedbackCardItem; onShown: () => void; onAnswered: (id: string) => void }) {
  const [state, formAction, pending] = useActionState(submitSetupFeedbackAction, initial);
  const [describing, setDescribing] = useState(false);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onShown();
  }, [onShown]);
  useEffect(() => {
    if (state.answeredId) doneRef.current?.focus();
  }, [state.answeredId]);

  if (state.answeredId) {
    return (
      <Card className="mb-5 flex items-start gap-3 border-[var(--color-success)]/25 bg-[var(--color-success-soft)]">
        <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success-ink)]" aria-hidden="true" />
        <div ref={doneRef} tabIndex={-1} role="status" className="min-w-0 flex-1 outline-none">
          <p className="text-[15px] font-semibold text-[var(--color-success-ink)]">
            {state.outcome === "ok" ? "Great, thank you!" : "Thanks, we got it."}
          </p>
          <p className="mt-0.5 text-sm text-[var(--color-success-ink)]">
            {state.outcome === "ok" ? "That helps us know this way of adding a device works." : "Your administrator will take a look."}
          </p>
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => onAnswered(state.answeredId!)}>
            Close
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-5 border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)]/50">
      <form action={formAction} aria-busy={pending} className="flex flex-col gap-4">
        <input type="hidden" name="deviceId" value={device.id} />
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--color-primary-fg)]">
            <Printer className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[17px] leading-6 font-semibold">Did it come out OK?</h2>
            <p className="mt-0.5 text-sm break-words text-[var(--color-text-2)]">
              Your first print from {device.name} ({deviceTypeLabel(device.device_type)}) went through. Did the paper come out the way you wanted?
            </p>
          </div>
        </div>

        {device.device_type === "mac" && (
          <fieldset className="min-w-0" disabled={pending}>
            <legend className="mb-1.5 text-sm font-medium">How did you add it?</legend>
            <div className="flex flex-col gap-2 sm:flex-row">
              {[
                { value: "terminal", label: "With the Terminal line" },
                { value: "ip_tab", label: "In System Settings (IP tab)" },
              ].map((o, i) => (
                <label
                  key={o.value}
                  className="flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border-2 border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium has-[:checked]:border-[var(--color-primary)] has-[:focus-visible]:shadow-[var(--ring)]"
                >
                  <input type="radio" name="variant" value={o.value} defaultChecked={i === 0} className="h-4 w-4 accent-[var(--color-primary)]" />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {describing ? (
          <>
            <Field label="What was wrong?" hint="(a few words is plenty)" htmlFor={`fb-note-${device.id}`}>
              <Textarea
                id={`fb-note-${device.id}`}
                name="note"
                rows={3}
                maxLength={FEEDBACK_NOTE_MAX}
                autoFocus
                disabled={pending}
                placeholder="For example: it printed blank pages"
                className="font-sans"
              />
            </Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setDescribing(false)}>
                Back
              </Button>
              <Button type="submit" name="outcome" value="problem" pending={pending} pendingLabel="Sending...">
                Send
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" name="outcome" value="ok" size="lg" pending={pending} pendingLabel="Saving..." className="sm:flex-1">
              <ThumbsUp className="h-4 w-4" aria-hidden="true" />
              Yes, it came out fine
            </Button>
            <Button type="button" variant="outline" size="lg" disabled={pending} onClick={() => setDescribing(true)} className="sm:flex-1">
              Something was wrong
            </Button>
          </div>
        )}
        <FormError message={state.error} />
      </form>
    </Card>
  );
}
