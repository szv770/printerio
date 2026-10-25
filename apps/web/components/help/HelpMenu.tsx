"use client";

import { useEffect, useState } from "react";
import { HelpCircle, X, PlayCircle } from "lucide-react";
import { STUDENT_TOUR, ADMIN_TOUR, GLOSSARY, TOUR_ENABLED } from "@/lib/onboarding-content";
import { SpotlightTour, readTourSession, clearTourSession } from "./SpotlightTour";

function storageKey(userId: string): string {
  return `printio:onboarding:${userId}:done`;
}

/**
 * Mounted once in each layout shell ((dashboard)/layout.tsx and
 * admin/layout.tsx) - shows the first-login tour automatically (tracked in
 * localStorage, per-user, so a shared machine or multiple accounts don't
 * collide; a real cross-device "seen" flag would need a DB column, left as
 * a follow-up rather than racing this against unrelated in-flight schema
 * work), and is always reachable afterward via the Help button to replay
 * the tour or look up a term in the glossary.
 *
 * The tour itself is a full-viewport spotlight walkthrough (SpotlightTour)
 * that highlights the real element each step is about, rather than a plain
 * slideshow - this component just owns *when* it's showing (first login,
 * "Replay tour", resuming one already in progress after a cross-page
 * navigation) and records that the user has seen it.
 */
export function HelpMenu({ userId, variant }: { userId: string; variant: "student" | "admin" }) {
  const slides = variant === "admin" ? ADMIN_TOUR : STUDENT_TOUR;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"tour" | "glossary">(TOUR_ENABLED ? "tour" : "glossary");
  const [tourActive, setTourActive] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  useEffect(() => {
    if (!TOUR_ENABLED) {
      // Tour switched off: drop any half-finished tour left in this browser so it can never resume.
      clearTourSession();
      return;
    }
    // Reads browser-only APIs not available during SSR/hydration, so this
    // can only run as an effect (not a lazy useState initializer) without
    // risking a hydration mismatch - every piece of state above is already
    // at a safe default, so only these two need setting here.
    const resumeStep = readTourSession(variant);
    if (resumeStep !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTourStep(resumeStep);
      setTourActive(true);
      return;
    }
    try {
      if (!localStorage.getItem(storageKey(userId))) {
        // First login: jump straight into the spotlight tour, not the plain
        // Help dialog.
        setTourActive(true);
      }
    } catch {
      // localStorage unavailable (private browsing, blocked cookies/storage)
      // - just skip auto-start; Help is still reachable manually below.
    }
  }, [userId, variant]);

  function markSeen() {
    try {
      localStorage.setItem(storageKey(userId), "1");
    } catch {
      // best-effort only - not worth surfacing an error over a UI nicety
    }
  }

  function endTour() {
    markSeen();
    clearTourSession();
    setTourActive(false);
  }

  function startTour() {
    setOpen(false);
    setTourStep(0);
    setTourActive(true);
  }

  function close() {
    setOpen(false);
  }

  function openHelp(startTab: "tour" | "glossary") {
    setTab(startTab);
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        data-tour="help-button"
        onClick={() => openHelp(tab)}
        className="flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
      >
        <HelpCircle className="h-4 w-4" />
        Help
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={close}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-[var(--color-surface)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex gap-4 text-sm font-medium">
                {TOUR_ENABLED && (
                  <button
                    type="button"
                    onClick={() => setTab("tour")}
                    className={tab === "tour" ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}
                  >
                    Tour
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setTab("glossary")}
                  className={tab === "glossary" || !TOUR_ENABLED ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}
                >
                  Glossary
                </button>
              </div>
              <button type="button" onClick={close} aria-label="Close help">
                <X className="h-4 w-4 text-[var(--color-muted)]" />
              </button>
            </div>

            {TOUR_ENABLED && tab === "tour" ? <TourLauncher onStart={startTour} /> : <GlossaryPanel />}
          </div>
        </div>
      )}

      {tourActive && (
        <SpotlightTour
          slides={slides}
          variant={variant}
          step={tourStep}
          setStep={setTourStep}
          onExit={endTour}
        />
      )}
    </>
  );
}

function TourLauncher({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-4 py-6 text-sm">
      <p className="text-[var(--color-muted)]">
        A guided walkthrough of the real screens and buttons you&apos;ll use - it highlights each one as it goes,
        and you can click along as it explains.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
      >
        <PlayCircle className="h-4 w-4" />
        Replay tour
      </button>
    </div>
  );
}

function GlossaryPanel() {
  return (
    <dl className="flex flex-1 flex-col gap-3 overflow-y-auto text-sm">
      {GLOSSARY.map((entry) => (
        <div key={entry.term}>
          <dt className="font-medium">{entry.term}</dt>
          <dd className="text-[var(--color-muted)]">{entry.definition}</dd>
        </div>
      ))}
    </dl>
  );
}
