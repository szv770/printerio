"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { readOpenState, resolveOpen, writeOpenState } from "@/lib/ui/collapsible-storage";

export interface CollapsibleProps {
  /** Stable, unique per page: used for the #hash, the DOM ids and remembered state. */
  id: string;
  title: string;
  /** One line shown under the title only while the section is closed. */
  summary?: ReactNode;
  /** Shown on the right of the header even when closed (e.g. a count). */
  badge?: ReactNode;
  /** Optional leading icon. */
  icon?: ReactNode;
  defaultOpen?: boolean;
  /** Error / needs-attention: opens the section (the user can still close it afterwards). */
  forceOpen?: boolean;
  headingLevel?: 2 | 3;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A card whose body folds away. Closed by default. The header is one big
 * button (aria-expanded / aria-controls, 56px tall); the body stays mounted
 * while closed so half-typed fields are not lost, and is hidden from the tab
 * order and screen readers by `visibility: hidden` + `inert`. Opens by itself
 * for `forceOpen` or when the URL hash equals `id`. Open state is remembered
 * per page in localStorage (read after mount, never during render). The height
 * animates with grid rows and is instant under prefers-reduced-motion.
 */
export function Collapsible({
  id,
  title,
  summary,
  badge,
  icon,
  defaultOpen = false,
  forceOpen = false,
  headingLevel = 2,
  onOpenChange,
  children,
}: CollapsibleProps) {
  const pathname = usePathname();
  const uid = useId();
  const buttonId = `${uid}-btn`;
  const panelId = `${uid}-panel`;
  const [open, setOpen] = useState(defaultOpen);

  // Open when forceOpen turns on (adjusting state during render, not in an effect).
  const [prevForce, setPrevForce] = useState(forceOpen);
  if (forceOpen !== prevForce) {
    setPrevForce(forceOpen);
    if (forceOpen) setOpen(true);
  }

  // Remembered state and #hash are browser-only, so they are read after mount.
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const stored = readOpenState(storage, pathname);
    const hash = window.location.hash;
    const next = resolveOpen({ id, stored, defaultOpen, forceOpen, hash });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser storage is the reason this is an effect
    setOpen(next);
    if (hash.replace(/^#/, "") === id) {
      document.getElementById(`${id}`)?.scrollIntoView({ block: "start" });
    }
    // Only on mount / page change: later changes come from clicks and forceOpen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      writeOpenState(window.localStorage, pathname, id, next);
    } catch {
      /* storage blocked: stays in memory only */
    }
    onOpenChange?.(next);
  }

  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section
      id={id}
      className="scroll-mt-20 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
    >
      <Heading>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-card)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:px-5"
        >
          {icon && (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              {icon}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold leading-6 text-[var(--color-text)]">{title}</span>
            {!open && summary && (
              <span className="mt-0.5 block text-[13px] leading-5 text-[var(--color-muted)]">{summary}</span>
            )}
          </span>
          {badge && <span className="shrink-0">{badge}</span>}
          <ChevronDown
            aria-hidden="true"
            className={`h-5 w-5 shrink-0 text-[var(--color-muted)] transition-transform duration-200 motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
      </Heading>
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
          <div className="border-t border-[var(--color-border)] px-4 py-4 sm:px-5 sm:py-5">{children}</div>
        </div>
      </div>
    </section>
  );
}
