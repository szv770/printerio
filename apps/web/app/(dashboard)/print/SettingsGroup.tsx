"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * One row of the print page's "More options" list: a header that always says in one line what the group is set to,
 * a small coloured dot when that differs from the usual, and a body that folds away.
 *
 * The body stays mounted while closed (hidden from the tab order and screen readers with `inert`), so the form
 * fields inside still submit and half-typed text is never lost. Groups open and close on their own: opening one
 * never closes another. The height animates and is instant under prefers-reduced-motion.
 */
export function SettingsGroup({
  id,
  title,
  icon,
  summary,
  changed = false,
  forceOpen = false,
  dataTour,
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  /** The live one-liner under the title: "Stapled top-left", "3 to 8". */
  summary: ReactNode;
  /** True when the group holds something other than the usual: shows the dot. */
  changed?: boolean;
  /** Opens the group when it turns true (an error or a result to look at); the person can still close it. */
  forceOpen?: boolean;
  dataTour?: string;
  children: ReactNode;
}) {
  const uid = useId();
  const buttonId = `${uid}-btn`;
  const panelId = `${uid}-panel`;
  const [open, setOpen] = useState(false);
  // Open when forceOpen turns on (adjusting state during render, not in an effect).
  const [prevForce, setPrevForce] = useState(forceOpen);
  if (forceOpen !== prevForce) {
    setPrevForce(forceOpen);
    if (forceOpen) setOpen(true);
  }

  return (
    <section id={id} data-tour={dataTour} className="scroll-mt-24">
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="group flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-2)]/60 focus-visible:outline-none focus-visible:bg-[var(--color-surface-2)]/60 focus-visible:shadow-[inset_0_0_0_2px_var(--color-primary)] sm:px-5"
        >
          {icon && <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-muted)]">{icon}</span>}
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium leading-5 text-[var(--color-text)]">{title}</span>
            <span className="mt-0.5 block truncate text-[13px] leading-5 text-[var(--color-muted)]">{summary}</span>
          </span>
          {changed && (
            <span className="flex shrink-0 items-center" data-testid="changed-dot">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />
              <span className="sr-only">Changed from the usual</span>
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-[var(--color-faint)] transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        inert={!open}
        className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none ${
          open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-5 px-4 pb-5 pt-1 sm:px-5">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** A small inline note (an estimate, a warning, a plain explanation): text with an icon, no box. */
export function InlineNote({
  tone = "muted",
  icon,
  children,
  ...rest
}: {
  tone?: "muted" | "warning" | "accent";
  icon?: ReactNode;
  children: ReactNode;
} & React.HTMLAttributes<HTMLParagraphElement>) {
  const color =
    tone === "warning" ? "text-[var(--color-warning-ink)]" : tone === "accent" ? "text-[var(--color-text-2)]" : "text-[var(--color-muted)]";
  return (
    <p role="status" {...rest} className={`flex items-start gap-1.5 text-[13px] leading-5 ${color} ${rest.className ?? ""}`}>
      {icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
