"use client";

import { useEffect, useState } from "react";
import { HelpCircle, X, ChevronLeft, ChevronRight } from "lucide-react";
import { STUDENT_TOUR, ADMIN_TOUR, GLOSSARY, type TourSlide } from "@/lib/onboarding-content";

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
 */
export function HelpMenu({ userId, variant }: { userId: string; variant: "student" | "admin" }) {
  const slides = variant === "admin" ? ADMIN_TOUR : STUDENT_TOUR;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"tour" | "glossary">("tour");
  const [step, setStep] = useState(0);

  useEffect(() => {
    // Reads a browser-only API not available during SSR/hydration, so this
    // can only run as an effect (not a lazy useState initializer) without
    // risking a hydration mismatch - tab/step are already at their "tour"/0
    // defaults, so only `open` needs setting here.
    try {
      if (!localStorage.getItem(storageKey(userId))) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setOpen(true);
      }
    } catch {
      // localStorage unavailable (private browsing, blocked cookies/storage)
      // - just skip auto-open; Help is still reachable manually below.
    }
  }, [userId]);

  function markSeen() {
    try {
      localStorage.setItem(storageKey(userId), "1");
    } catch {
      // best-effort only - not worth surfacing an error over a UI nicety
    }
  }

  function close() {
    markSeen();
    setOpen(false);
  }

  function openHelp(startTab: "tour" | "glossary") {
    setTab(startTab);
    if (startTab === "tour") setStep(0);
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
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
                <button
                  type="button"
                  onClick={() => setTab("tour")}
                  className={tab === "tour" ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}
                >
                  Tour
                </button>
                <button
                  type="button"
                  onClick={() => setTab("glossary")}
                  className={tab === "glossary" ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}
                >
                  Glossary
                </button>
              </div>
              <button type="button" onClick={close} aria-label="Close help">
                <X className="h-4 w-4 text-[var(--color-muted)]" />
              </button>
            </div>

            {tab === "tour" ? (
              <TourPanel slides={slides} step={step} setStep={setStep} onDone={close} />
            ) : (
              <GlossaryPanel />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TourPanel({
  slides,
  step,
  setStep,
  onDone,
}: {
  slides: TourSlide[];
  step: number;
  setStep: (n: number) => void;
  onDone: () => void;
}) {
  const slide = slides[step];
  const isLast = step === slides.length - 1;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex-1">
        <p className="text-base font-semibold">{slide?.title}</p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{slide?.body}</p>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <div className="flex gap-1">
          {slides.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
          )}
          {isLast ? (
            <button
              type="button"
              onClick={onDone}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              className="flex items-center gap-1 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
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
