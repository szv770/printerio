"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, MousePointerClick, X } from "lucide-react";
import type { TourSlide } from "@/lib/onboarding-content";
import { computeCalloutPlacement, padRect, buildSpotlightPath, type Rect } from "@/lib/tour-position";

const HOLE_PADDING = 8;
const HOLE_RADIUS = 14;
const CALLOUT_GAP = 18;
/** Below this width the card docks to the top or bottom edge instead of floating beside the target. */
const PHONE_WIDTH = 640;
const ANCHOR_POLL_ATTEMPTS = 20;
const ANCHOR_POLL_INTERVAL_MS = 120;
/** Above the Modal (z-100) and every shell element. */
const TOUR_Z = "z-[110]";

const SESSION_ACTIVE_KEY = "printio:onboarding:tour:variant";
const SESSION_STEP_KEY = "printio:onboarding:tour:step";

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // best-effort only
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const noopSubscribe = () => () => {};

/**
 * The guided walkthrough: dims the page, cuts a spotlight around the real element a step is about, and shows a card
 * beside it. Each step names a `data-tour="<anchor>"` element and the route it lives on (lib/onboarding-content.ts).
 * It navigates there itself, waits briefly for the element to appear, and falls back to a centred card when it
 * never does, so it never points at nothing. Rendered through a portal above every other layer.
 *
 * Keys: Right/Enter = next, Left = back, Escape = leave.
 */
export function SpotlightTour({
  slides,
  variant,
  step,
  setStep,
  onExit,
}: {
  slides: TourSlide[];
  variant: "student" | "admin";
  step: number;
  setStep: (step: number) => void;
  onExit: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const slide = slides[step];
  const isLast = step === slides.length - 1;
  const reducedMotion = mounted && prefersReducedMotion();

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [resolution, setResolution] = useState<"searching" | "found" | "missing">("searching");
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [calloutSize, setCalloutSize] = useState({ width: 340, height: 180 });
  const [clicked, setClicked] = useState(false);

  const calloutRef = useRef<HTMLDivElement>(null);
  const pushedRouteRef = useRef<string | null>(null);

  useEffect(() => {
    writeSession(SESSION_ACTIVE_KEY, variant);
    writeSession(SESSION_STEP_KEY, String(step));
  }, [variant, step]);

  const goTo = useCallback(
    (next: number) => {
      setClicked(false);
      setResolution("searching");
      setTargetRect(null);
      setStep(Math.min(Math.max(next, 0), slides.length - 1));
    },
    [setStep, slides.length],
  );
  const advance = useCallback(() => goTo(step + 1), [goTo, step]);
  const goBack = useCallback(() => goTo(step - 1), [goTo, step]);

  // Cross-page steps: go to the step's page first. The ref stops a second push before the address updates.
  // The developer preview has no real routes to walk between, so it shows each step where it is.
  const inPreview = process.env.NODE_ENV !== "production" && (pathname ?? "").startsWith("/dev/preview");

  useEffect(() => {
    if (inPreview || !slide?.route || slide.route === pathname) {
      pushedRouteRef.current = null;
      return;
    }
    if (pushedRouteRef.current === slide.route) return;
    pushedRouteRef.current = slide.route;
    router.push(slide.route);
  }, [slide, pathname, router, inPreview]);

  const onRoute = inPreview || !slide?.route || slide.route === pathname;

  // Find the element (it may mount late), scroll it into view, and follow it as the page scrolls or resizes.
  useEffect(() => {
    if (!onRoute || !slide?.anchor) return;
    const anchor = slide.anchor;
    let cancelled = false;
    let attempts = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let rafId: number | null = null;
    let element: Element | null = null;

    function updateRect() {
      if (!element || cancelled) return;
      const r = element.getBoundingClientRect();
      setTargetRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    function scheduleUpdate() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateRect();
      });
    }
    function poll() {
      if (cancelled) return;
      element = document.querySelector(`[data-tour="${CSS.escape(anchor)}"]`);
      // An element that is not on screen (hidden by the layout) cannot be spotlighted.
      if (element && element.getClientRects().length > 0) {
        setResolution("found");
        element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center", inline: "nearest" });
        updateRect();
        return;
      }
      element = null;
      attempts += 1;
      if (attempts >= ANCHOR_POLL_ATTEMPTS) {
        setViewport({ width: window.innerWidth, height: window.innerHeight });
        setResolution("missing");
        return;
      }
      pollTimer = setTimeout(poll, ANCHOR_POLL_INTERVAL_MS);
    }

    poll();
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate);
    // Smooth scrolling and late layout shifts move the element after the first measurement.
    const settle = setInterval(scheduleUpdate, 250);
    return () => {
      cancelled = true;
      clearInterval(settle);
      if (pollTimer) clearTimeout(pollTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [slide, onRoute, reducedMotion]);

  // Steps that wait for a real click: the click still does what it normally does; the tour moves on after it.
  useEffect(() => {
    if (resolution !== "found" || !slide?.clickToAdvance || !slide.anchor) return;
    const element = document.querySelector(`[data-tour="${CSS.escape(slide.anchor)}"]`);
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function handleClick() {
      setClicked(true);
      timer = setTimeout(advance, 50);
    }
    element.addEventListener("click", handleClick, { once: true });
    return () => {
      element.removeEventListener("click", handleClick);
      if (timer) clearTimeout(timer);
    };
  }, [resolution, slide, advance]);

  // The card's own size varies with its text; placement needs the real number.
  useEffect(() => {
    const el = calloutRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setCalloutSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resolution, step, mounted, onRoute]);

  // Keyboard, and focus on the card so keys and screen readers land in the tour.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (isLast) onExit();
        else advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit, advance, goBack, isLast]);

  useEffect(() => {
    if (mounted && onRoute) calloutRef.current?.focus({ preventScroll: true });
  }, [mounted, onRoute, step]);

  if (!mounted || !slide || !onRoute) return null;

  const spotlighted = resolution === "found" && targetRect !== null && viewport.width > 0;
  const hole = spotlighted ? padRect(targetRect, HOLE_PADDING) : null;
  const phone = viewport.width > 0 && viewport.width < PHONE_WIDTH;
  const placement = hole && !phone ? computeCalloutPlacement(hole, viewport, calloutSize, CALLOUT_GAP) : null;
  const path = hole ? buildSpotlightPath(hole, viewport, HOLE_RADIUS) : null;
  const dockTop = phone && hole ? hole.top + hole.height / 2 > viewport.height / 2 : false;
  const waitingOnClick = !!slide.clickToAdvance && spotlighted && !clicked;

  let cardStyle: React.CSSProperties;
  let cardClass: string;
  if (placement) {
    cardStyle = { top: placement.top, left: placement.left };
    cardClass = "w-[22rem]";
  } else if (phone && spotlighted) {
    cardStyle = dockTop ? { top: "max(0.75rem, env(safe-area-inset-top))", left: "0.75rem", right: "0.75rem" } : { bottom: "max(0.75rem, env(safe-area-inset-bottom))", left: "0.75rem", right: "0.75rem" };
    cardClass = "";
  } else {
    cardStyle = { inset: 0, margin: "auto", height: "fit-content", width: "min(24rem, calc(100vw - 1.5rem))" };
    cardClass = "";
  }

  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="tour-title" className={`pointer-events-none fixed inset-0 ${TOUR_Z}`}>
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes printio-tour-pulse { 0%,100% { stroke-opacity: .95 } 50% { stroke-opacity: .45 } }
          @keyframes printio-tour-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
          [data-tour-ring] { animation: printio-tour-pulse 2.2s ease-in-out infinite }
          [data-tour-card] { animation: printio-tour-in 220ms ease-out both }
        }
      `}</style>
      {spotlighted && path ? (
        <svg className="pointer-events-auto fixed inset-0 h-full w-full" width={viewport.width} height={viewport.height} aria-hidden="true">
          <path d={path} fillRule="evenodd" fill="rgba(20,17,10,0.62)" />
          {hole && (
            <rect
              data-tour-ring
              x={hole.left}
              y={hole.top}
              width={hole.width}
              height={hole.height}
              rx={HOLE_RADIUS}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={2.5}
              className="pointer-events-none"
            />
          )}
        </svg>
      ) : (
        <div className="pointer-events-auto fixed inset-0 bg-[#14110a]/60 backdrop-blur-[2px]" aria-hidden="true" />
      )}

      <div
        ref={calloutRef}
        data-tour-card
        tabIndex={-1}
        className={`pointer-events-auto fixed flex max-h-[calc(100dvh-1.5rem)] flex-col gap-3 overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-pop)] ring-1 ring-[var(--color-border)] outline-none focus-visible:outline-none ${cardClass} ${
          reducedMotion ? "" : "transition-[top,left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        }`}
        style={cardStyle}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] font-semibold tracking-wide text-[var(--color-primary)] uppercase">
            Step {step + 1} of {slides.length}
          </p>
          <button
            type="button"
            onClick={onExit}
            aria-label="Leave the walkthrough"
            className="-mr-2 -mt-2 flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] sm:h-9 sm:w-9"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div>
          <h2 id="tour-title" className="text-[1.0625rem] leading-6 font-semibold text-[var(--color-text)]">
            {slide.title}
          </h2>
          <p className="mt-1.5 text-[15px] leading-6 text-[var(--color-text-2)]">{slide.body}</p>
          {waitingOnClick && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-primary)]">
              <MousePointerClick className="h-4 w-4" aria-hidden="true" />
              Try it: tap the highlighted spot, or press Next.
            </p>
          )}
        </div>

        <div className="flex justify-center gap-1.5" role="presentation">
          {slides.map((s, i) => (
            <span
              key={s.title}
              aria-hidden="true"
              className={`h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none ${i === step ? "w-5 bg-[var(--color-primary)]" : i < step ? "w-1.5 bg-[var(--color-primary)]/40" : "w-1.5 bg-[var(--color-border-strong)]"}`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onExit}
            className="min-h-11 rounded-[var(--radius-control)] px-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={goBack}
                className="flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
              </button>
            )}
            <button
              type="button"
              onClick={isLast ? onExit : advance}
              className="flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
            >
              {isLast ? "Done" : "Next"}
              {!isLast && <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Reads back a tour in progress (across a hard refresh / route push that remounted this component) - see the persistence effect above. Returns null when there's nothing to resume for this `variant`. */
export function readTourSession(variant: "student" | "admin"): number | null {
  if (readSession(SESSION_ACTIVE_KEY) !== variant) return null;
  const raw = readSession(SESSION_STEP_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Clears any persisted in-progress tour - call this on real finish/skip so a later replay starts fresh rather than resuming a stale step. */
export function clearTourSession() {
  writeSession(SESSION_ACTIVE_KEY, null);
  writeSession(SESSION_STEP_KEY, null);
}
