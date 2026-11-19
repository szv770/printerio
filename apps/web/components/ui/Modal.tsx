"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * The one dialog for the whole app. It renders through a portal into document.body, so no ancestor (a header with
 * backdrop-blur, a drawer with a transform) can ever turn its `fixed` box into something smaller. On phones it is a
 * bottom sheet; from `sm` up it is a centred card.
 *
 * Layering: the member tab bar is z-60 and the admin drawer z-50, so dialogs sit at z-[100]. The guided tour sits
 * above this at z-[110].
 */

export const MODAL_Z = "z-[100]";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/** Where Tab should land next inside a trap of `count` focusable items; -1 means "let the browser decide". */
export function nextTrapIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : -1;
  return current === count - 1 ? 0 : -1;
}

function visibleFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0,
  );
}

const noopSubscribe = () => () => {};
/** False on the server and during hydration, true afterwards - the portal only exists on the client. */
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

// Body scroll lock shared by every open dialog (a counter, so stacked dialogs restore it exactly once).
let lockCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

function lockScroll() {
  if (lockCount++ > 0) return;
  const body = document.body;
  const gap = window.innerWidth - document.documentElement.clientWidth;
  savedOverflow = body.style.overflow;
  savedPaddingRight = body.style.paddingRight;
  if (gap > 0) {
    const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${current + gap}px`;
  }
  body.style.overflow = "hidden";
}

function unlockScroll() {
  if (lockCount === 0 || --lockCount > 0) return;
  document.body.style.overflow = savedOverflow;
  document.body.style.paddingRight = savedPaddingRight;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Small line under the title. */
  description?: string;
  /** Fixed area under the title that does not scroll (tabs). */
  header?: ReactNode;
  children: ReactNode;
  /** Fixed area at the bottom that does not scroll (buttons). */
  footer?: ReactNode;
  /** Ignore Escape and backdrop clicks (the X button still works unless hideClose). */
  locked?: boolean;
  hideClose?: boolean;
  /** Focus this on open instead of the dialog itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Extra classes for the dialog card. */
  className?: string;
}

export function Modal({ open, onClose, title, description, header, children, footer, locked = false, hideClose = false, initialFocusRef, className = "" }: ModalProps) {
  const mounted = useMounted();
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const visible = mounted && open;

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    if (!visible) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lockScroll();
    const frame = requestAnimationFrame(() => {
      (initialFocusRef?.current ?? panelRef.current)?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      unlockScroll();
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [visible, initialFocusRef]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape" && !locked) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = visibleFocusables(panelRef.current);
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const target = nextTrapIndex(idx, items.length, e.shiftKey);
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
      } else if (target >= 0) {
        e.preventDefault();
        items[target]?.focus();
      }
    },
    [locked],
  );

  // Escape also works when focus has drifted outside the panel (for example after a click on the backdrop).
  useEffect(() => {
    if (!visible || locked) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !panelRef.current?.contains(document.activeElement)) onCloseRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible, locked]);

  if (!visible) return null;

  return createPortal(
    <div
      data-modal-root
      className={`fixed inset-0 ${MODAL_Z} flex items-end justify-center sm:items-center sm:p-6`}
      onKeyDown={onKeyDown}
    >
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes printio-modal-fade { from { opacity: 0 } to { opacity: 1 } }
          @keyframes printio-modal-sheet { from { transform: translateY(24px); opacity: 0 } to { transform: none; opacity: 1 } }
          @keyframes printio-modal-card { from { transform: translateY(8px) scale(.98); opacity: 0 } to { transform: none; opacity: 1 } }
          [data-modal-backdrop] { animation: printio-modal-fade 180ms ease-out both }
          [data-modal-panel] { animation: printio-modal-sheet 260ms cubic-bezier(.22,1,.36,1) both }
          @media (min-width: 640px) { [data-modal-panel] { animation-name: printio-modal-card } }
        }
      `}</style>
      <div
        data-modal-backdrop
        aria-hidden="true"
        className="absolute inset-0 bg-[#14110a]/45 backdrop-blur-[3px]"
        onMouseDown={() => {
          if (!locked) onCloseRef.current();
        }}
      />
      <div
        ref={panelRef}
        data-modal-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-[1.5rem] bg-[var(--color-surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-pop)] outline-none ring-1 ring-[var(--color-border)] sm:max-h-[min(44rem,calc(100dvh-3rem))] sm:max-w-[34rem] sm:rounded-[var(--radius-card)] sm:pb-0 ${className}`}
      >
        <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-[var(--color-border-strong)]" />
        </div>
        <div className="flex items-start gap-3 px-5 pt-3 pb-3 sm:px-6 sm:pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[1.25rem] leading-7 font-semibold text-[var(--color-text)]">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm leading-5 text-[var(--color-muted)]">
                {description}
              </p>
            )}
          </div>
          {!hideClose && (
            <button
              type="button"
              onClick={() => onCloseRef.current()}
              aria-label="Close"
              className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:-mt-1 sm:h-9 sm:w-9"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>
        {header && <div className="shrink-0 px-5 sm:px-6">{header}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6 [scrollbar-width:thin]">{children}</div>
        {footer && <div className="shrink-0 border-t border-[var(--color-border)] px-5 py-3 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
