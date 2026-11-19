"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, FileQuestion, HelpCircle, LifeBuoy, PlayCircle, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { buttonClass } from "@/components/ui/Button";
import { ADMIN_TOUR, GLOSSARY, STUDENT_TOUR, TOUR_AUTOSTART, TOUR_REPLAY_ENABLED } from "@/lib/onboarding-content";
import { GENERIC_HELP, helpForPath } from "@/lib/help-content";
import { SpotlightTour, readTourSession, clearTourSession } from "./SpotlightTour";
import { PageHelp } from "./PageHelp";
import { ReportProblemLink } from "./ReportProblemLink";
import { OPEN_HELP_EVENT, type HelpTab } from "./open-help";

function storageKey(userId: string): string {
  return `printio:onboarding:${userId}:done`;
}

const TABS: Array<{ id: HelpTab; label: string }> = [
  { id: "page", label: "This page" },
  { id: "walkthrough", label: "Walkthrough" },
  { id: "glossary", label: "Glossary" },
  { id: "report", label: "Report a problem" },
];

/**
 * The Help button and window, mounted once in each shell. The window is a Modal (portal, so no header or drawer can
 * squash it) with four tabs: help for this page, the guided walkthrough, a glossary, and "Report a problem".
 * It also owns when the walkthrough is showing: replay from here, resume after a page change, and (only when
 * TOUR_AUTOSTART is on) the first sign-in.
 */
export function HelpMenu({ userId, variant, pathname: pathnameProp }: { userId: string; variant: "student" | "admin"; pathname?: string }) {
  const realPathname = usePathname();
  const pathname = pathnameProp ?? realPathname;
  const slides = variant === "admin" ? ADMIN_TOUR : STUDENT_TOUR;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<HelpTab>("page");
  const [tourActive, setTourActive] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  useEffect(() => {
    if (!TOUR_REPLAY_ENABLED && !TOUR_AUTOSTART) {
      clearTourSession();
      return;
    }
    // Browser-only reads, so they run after hydration.
    const resumeStep = readTourSession(variant);
    if (resumeStep !== null && TOUR_REPLAY_ENABLED) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTourStep(resumeStep);
      setTourActive(true);
      return;
    }
    if (!TOUR_AUTOSTART) return;
    try {
      if (!localStorage.getItem(storageKey(userId))) setTourActive(true);
    } catch {
      // storage blocked: skip the automatic start; Help still works
    }
  }, [userId, variant]);

  useEffect(() => {
    function onOpen(e: Event) {
      const wanted = (e as CustomEvent<HelpTab>).detail;
      setTab(wanted ?? "page");
      setOpen(true);
    }
    window.addEventListener(OPEN_HELP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_HELP_EVENT, onOpen);
  }, []);

  const endTour = useCallback(() => {
    try {
      localStorage.setItem(storageKey(userId), "1");
    } catch {
      // best effort
    }
    clearTourSession();
    setTourActive(false);
  }, [userId]);

  function startTour() {
    setOpen(false);
    setTourStep(0);
    setTourActive(true);
  }

  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  function onTabKey(e: React.KeyboardEvent, i: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + TABS.length) % TABS.length;
    const target = TABS[next];
    if (!target) return;
    setTab(target.id);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      <button
        type="button"
        data-tour="help-button"
        onClick={() => {
          setTab("page");
          setOpen(true);
        }}
        className="flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
      >
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
        Help
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Help"
        description="Plain answers for the page you are on."
        header={
          <div role="tablist" aria-label="Help topics" className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] p-1 sm:grid-cols-4">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${baseId}-panel`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`min-h-10 rounded-[calc(var(--radius-control)-4px)] px-2 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
                  tab === t.id ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-xs)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`} className="min-h-[18rem]">
          {tab === "page" && <ThisPage pathname={pathname} />}
          {tab === "walkthrough" && <Walkthrough steps={slides.length} onStart={startTour} />}
          {tab === "glossary" && <GlossaryPanel />}
          {tab === "report" && <ReportPanel />}
        </div>
      </Modal>

      {tourActive && <SpotlightTour slides={slides} variant={variant} step={tourStep} setStep={setTourStep} onExit={endTour} />}
    </>
  );
}

function ThisPage({ pathname }: { pathname: string | null }) {
  const [search, setSearch] = useState("");
  useEffect(() => {
    // Only the developer preview reads the address bar, so every page can be looked at without signing in.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch(window.location.search);
  }, []);
  const page = helpForPath(pathname, search);
  return (
    <div>
      <h3 className="mb-3 text-[1.0625rem] font-semibold text-[var(--color-text)]">{page ? page.title : GENERIC_HELP.title}</h3>
      <PageHelp page={page ?? GENERIC_HELP} generic={!page} />
    </div>
  );
}

function Walkthrough({ steps, onStart }: { steps: number; onStart: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
        <PlayCircle className="h-6 w-6" aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-[1.0625rem] font-semibold text-[var(--color-text)]">A guided walkthrough</h3>
        <p className="mt-1 text-[15px] leading-6 text-[var(--color-text-2)]">
          It highlights the real buttons and screens one at a time and explains each in a sentence or two. {steps} short steps, about a minute. You can go back, skip, or leave at any time.
        </p>
      </div>
      {TOUR_REPLAY_ENABLED ? (
        <button type="button" onClick={onStart} className={buttonClass("primary", "default")}>
          <PlayCircle className="h-4 w-4" aria-hidden="true" />
          Start the walkthrough
        </button>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">The walkthrough is not available yet.</p>
      )}
    </div>
  );
}

function GlossaryPanel() {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const entries = [...GLOSSARY]
    .sort((a, b) => a.term.localeCompare(b.term))
    .filter((e) => !needle || e.term.toLowerCase().includes(needle) || e.definition.toLowerCase().includes(needle));
  return (
    <div className="flex flex-col gap-4">
      <label className="relative block">
        <span className="sr-only">Search the glossary</span>
        <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[var(--color-faint)]" aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search words, like quota or queue"
          className="min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] pr-3 pl-10 text-[15px] placeholder:text-[var(--color-faint)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
        />
      </label>
      {entries.length === 0 ? (
        <p className="flex items-center gap-2 py-6 text-sm text-[var(--color-muted)]">
          <FileQuestion className="h-4 w-4" aria-hidden="true" />
          No word matches that. Try a shorter search.
        </p>
      ) : (
        <dl className="flex flex-col divide-y divide-[var(--color-border)]">
          {entries.map((e) => (
            <div key={e.term} className="py-3 first:pt-0">
              <dt className="text-[15px] font-semibold text-[var(--color-text)]">{e.term}</dt>
              <dd className="mt-0.5 text-[14px] leading-6 text-[var(--color-muted)]">{e.definition}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ReportPanel() {
  return (
    <div className="flex flex-col items-start gap-4">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-warning-soft)] text-[var(--color-warning)]">
        <LifeBuoy className="h-6 w-6" aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-[1.0625rem] font-semibold text-[var(--color-text)]">Something not working?</h3>
        <p className="mt-1 text-[15px] leading-6 text-[var(--color-text-2)]">Tell us what you were trying to do. We add four small details to help us find the cause:</p>
        <ul className="mt-2 flex flex-col gap-1 text-[14px] text-[var(--color-muted)]">
          {["The page you are on", "The Printio version", "Your browser", "An error reference, if one was shown"].map((t) => (
            <li key={t} className="flex gap-2">
              <BookOpen className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[14px] text-[var(--color-muted)]">Nothing else about you is included.</p>
      </div>
      <ReportProblemLink variant="primary" />
    </div>
  );
}
