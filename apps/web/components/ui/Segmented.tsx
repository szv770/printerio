"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Shown as a tooltip and read out by screen readers for a disabled option. */
  disabledReason?: string | null;
}

/**
 * A big-tap-target radio group drawn as joined segments. It renders buttons (not native radios) and ONE hidden
 * input carrying the value, so the form always submits the value shown - a disabled native radio would simply be
 * left out of the FormData. Arrow keys move the selection like any radio group.
 *
 * Defined at module level on purpose: a component declared inside another component's render is a new component
 * every render, which remounts it and loses focus mid-interaction.
 */
export function Segmented<V extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
  hint,
  error,
}: {
  /** Form field name for the hidden input; omit for a control that is never submitted. */
  name?: string;
  label: string;
  value: V;
  options: SegmentedOption<V>[];
  onChange: (next: V) => void;
  disabled?: boolean;
  /** One line under the control (why something is locked, what an option means). */
  hint?: ReactNode;
  error?: string | null;
}) {
  const labelId = useId();
  const hintId = useId();
  const enabled = options.filter((o) => !disabled && !o.disabledReason);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, current: V) {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !back) return;
    e.preventDefault();
    const idx = enabled.findIndex((o) => o.value === current);
    const next = enabled[(idx + (forward ? 1 : -1) + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  }

  return (
    <div>
      <p id={labelId} className="mb-1.5 text-sm font-medium">
        {label}
      </p>
      {name && <input type="hidden" name={name} value={value} />}
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={hint || error ? hintId : undefined}
        className="grid gap-1 rounded-xl bg-[var(--color-border)]/50 p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((o) => {
          const selected = o.value === value;
          const off = disabled || !!o.disabledReason;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={off || undefined}
              title={o.disabledReason ?? undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!off) onChange(o.value);
              }}
              onKeyDown={(e) => onKeyDown(e, o.value)}
              className={`min-h-11 rounded-lg px-2 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${
                selected
                  ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm ring-1 ring-[var(--color-border)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              } ${off ? "cursor-not-allowed opacity-50 hover:text-[var(--color-muted)]" : ""}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {(hint || error) && (
        <p id={hintId} className={`mt-1.5 text-xs ${error ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
