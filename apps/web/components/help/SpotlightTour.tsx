"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, X, MousePointerClick } from "lucide-react";
import type { TourSlide } from "@/lib/onboarding-content";
import { computeArrowOffset, computeCalloutPlacement, padRect, buildSpotlightPath, type Rect } from "@/lib/tour-position";

const HOLE_PADDING = 8;
const HOLE_RADIUS = 12;
const CALLOUT_GAP = 18;
// How long we keep polling for a late-mounting anchor (a Supabase realtime
// row still loading, a client component still hydrating) before treating it
// the same as "not present for this role" and falling back to a centered
// callout - never pointing the spotlight at nothing.
const ANCHOR_POLL_ATTEMPTS = 20;
const ANCHOR_POLL_INTERVAL_MS = 120;

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
    // best-effort only - a lost in-flight step just means a hard refresh
    // mid-tour restarts it, not a broken tour.
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The full-viewport guided-tour overlay: dims everything except the real
 * element a step is talking about, with a callout beside it. Mounted by
 * HelpMenu (both the "student" and "admin" variants) whenever a tour is
 * active - see components/help/HelpMenu.tsx for how it's launched and how
 * finishing is recorded.
 *
 * Anchoring: each step optionally names a `data-tour="<anchor>"` element and
 * the route it lives on (lib/onboarding-content.ts). This component
 * navigates there itself when needed, polls briefly for the element to
 * mount, and - if it never shows up (not present for this role, an empty
 * state, still loading) - falls back to a centered callout with the same
 * copy rather than ever pointing at nothing.
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
  const slide = slides[step];
  const isLast = step === slides.length - 1;
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  // Anchor resolution has three states: "searching" (still polling, nothing
  // rendered yet so we never flash the fallback for a split second), "found"
  // (a real element is highlighted), and "missing" (gave up polling - render
  // the centered fallback). A step with no anchor at all skips straight to
  // "missing" (i.e. centered), which is exactly the fallback layout too.
  const [resolution, setResolution] = useState<"searching" | "found" | "missing">("searching");
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [calloutSize, setCalloutSize] = useState({ width: 320, height: 160 });
  const [clicked, setClicked] = useState(false);

  const calloutRef = useRef<HTMLDivElement>(null);
  const pushedRouteRef = useRef<string | null>(null);

  // Persist current step across a real navigation (see the route-mismatch
  // effect below) or a hard refresh mid-tour, so resuming picks up where the
  // user left off instead of restarting from step 0.
  useEffect(() => {
    writeSession(SESSION_ACTIVE_KEY, variant);
    writeSession(SESSION_STEP_KEY, String(step));
  }, [variant, step]);

  const advance = useCallback(() => {
    setClicked(false);
    setResolution("searching");
    setTargetRect(null);
    setStep(Math.min(step + 1, slides.length - 1));
  }, [step, slides.length, setStep]);

  const goBack = useCallback(() => {
    setClicked(false);
    setResolution("searching");
    setTargetRect(null);
    setStep(Math.max(step - 1, 0));
  }, [step, setStep]);

  // Cross-page steps: if this step's anchor lives on a different route than
  // the one we're currently on, navigate there ourselves. Guarded by a ref
  // (not just state) so a render in-between the push and the pathname
  // actually updating doesn't fire a second push.
  useEffect(() => {
    if (!slide?.route || slide.route === pathname) {
      pushedRouteRef.current = null;
      return;
    }
    if (pushedRouteRef.current === slide.route) return;
    pushedRouteRef.current = slide.route;
    router.push(slide.route);
  }, [slide, pathname, router]);

  const onRoute = !slide?.route || slide.route === pathname;

  // Locate the anchored element (polling briefly for one that mounts late),
  // scroll it into view, and keep its rect fresh across scroll/resize.
  useEffect(() => {
    if (!onRoute) return;
    // No anchor at all -> render as the centered fallback. That's already
    // what the default "searching" resolution looks like (spotlighted only
    // ever turns true once a "found" element's rect is known), so there's
    // nothing to set here - advance()/goBack() already reset resolution to
    // "searching" for the new step before this effect runs.
    if (!slide?.anchor) return;

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
      if (element) {
        setResolution("found");
        element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center", inline: "nearest" });
        updateRect();
        return;
      }
      attempts += 1;
      if (attempts >= ANCHOR_POLL_ATTEMPTS) {
        setResolution("missing");
        return;
      }
      pollTimer = setTimeout(poll, ANCHOR_POLL_INTERVAL_MS);
    }

    poll();
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [slide, onRoute, reducedMotion]);

  // Click-driven steps: a real click on the target both does whatever it
  // normally does (we never call preventDefault/stopPropagation) and
  // advances the tour right after.
  useEffect(() => {
    if (resolution !== "found" || !slide?.clickToAdvance || !slide.anchor) return;
    const element = document.querySelector(`[data-tour="${CSS.escape(slide.anchor)}"]`);
    if (!element) return;
    function handleClick() {
      setClicked(true);
      // Give the element's own click handler (e.g. a real navigation) a
      // moment to start before we advance the tour underneath it.
      setTimeout(advance, 50);
    }
    element.addEventListener("click", handleClick, { once: true });
    return () => element.removeEventListener("click", handleClick);
  }, [resolution, slide, advance]);

  // Track the callout's own rendered size (it varies with copy length) so
  // the placement math can clamp it fully on-screen.
  useEffect(() => {
    if (!calloutRef.current) return;
    const el = calloutRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setCalloutSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resolution, step]);

  // Escape always exits (and marks the tour seen, same as Skip).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onExit();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  if (!slide || !onRoute) return null;

  const spotlighted = resolution === "found" && targetRect !== null && viewport.width > 0;
  const hole = spotlighted ? padRect(targetRect!, HOLE_PADDING) : null;
  const placement = spotlighted
    ? computeCalloutPlacement(hole!, viewport, calloutSize, CALLOUT_GAP)
    : null;
  const arrowOffset = spotlighted && placement ? computeArrowOffset(placement, hole!, calloutSize) : null;
  const path = spotlighted ? buildSpotlightPath(hole!, viewport, HOLE_RADIUS) : null;

  const waitingOnClick = !!slide.clickToAdvance && spotlighted && !clicked;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Printio tour: ${slide.title}`}
      className="fixed inset-0 z-[100]"
    >
      {spotlighted && path ? (
        <svg
          className="pointer-events-auto fixed inset-0 h-full w-full"
          width={viewport.width}
          height={viewport.height}
        >
          <path
            d={path}
            fillRule="evenodd"
            fill="rgba(0,0,0,0.65)"
            stroke="var(--color-primary)"
            strokeWidth={2}
            style={{ filter: "drop-shadow(0 0 14px var(--color-primary))" }}
          />
        </svg>
      ) : (
        <div className="fixed inset-0 bg-black/65" />
      )}

      <div
        ref={calloutRef}
        className={`fixed z-[101] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl ${
          reducedMotion ? "" : "transition-[top,left] duration-200 ease-out"
        }`}
        style={
          spotlighted && placement
            ? { top: placement.top, left: placement.left }
            : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
        }
      >
        {spotlighted && placement && arrowOffset !== null && (
          <Arrow side={placement.side} offset={arrowOffset} />
        )}

        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
            Step {step + 1} of {slides.length}
          </p>
          <button
            type="button"
            onClick={onExit}
            aria-label="Skip tour"
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div>
          <p className="text-base font-semibold">{slide.title}</p>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">{slide.body}</p>
        </div>

        <div className="mt-1 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onExit}
            className="text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={goBack}
                className="flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                <ChevronLeft className="h-4 w-4" /> Back
              </button>
            )}
            {waitingOnClick ? (
              <span className="flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)]/10 px-3 py-2 text-sm font-medium text-[var(--color-primary)]">
                <MousePointerClick className="h-4 w-4" />
                Click the highlighted area to continue
              </span>
            ) : isLast ? (
              <button
                type="button"
                onClick={onExit}
                className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                onClick={advance}
                className="flex items-center gap-1 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Arrow({ side, offset }: { side: "top" | "bottom" | "left" | "right"; offset: number }) {
  const base = "absolute h-3 w-3 rotate-45 border border-[var(--color-border)] bg-[var(--color-surface)]";
  switch (side) {
    case "right":
      return <span className={`${base} -left-1.5 border-r-0 border-t-0`} style={{ top: offset - 6 }} />;
    case "left":
      return <span className={`${base} -right-1.5 border-l-0 border-b-0`} style={{ top: offset - 6 }} />;
    case "bottom":
      return <span className={`${base} -top-1.5 border-b-0 border-r-0`} style={{ left: offset - 6 }} />;
    case "top":
      return <span className={`${base} -bottom-1.5 border-t-0 border-l-0`} style={{ left: offset - 6 }} />;
  }
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
