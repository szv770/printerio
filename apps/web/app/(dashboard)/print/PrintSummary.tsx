import type { ReactNode } from "react";

/** "12 pages · 2 copies · double-sided · stapled" -> "12 pages, 2 copies, double-sided, stapled". */
export function summarySentence(liveLine: string): string {
  return liveLine
    .split(" · ")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * The Print summary: what is about to happen in one plain sentence, the sheet count, and the Print button.
 * On a phone it is the bar that floats above the tab bar (text on the left, button on the right); from lg up it
 * is a card that stays in view beside the settings. Presentational only: PrintForm decides every value.
 */
export function PrintSummary({
  ready,
  line,
  sheets,
  notes,
  error,
  className = "",
  children,
}: {
  /** A file is chosen (or its page count is known): otherwise the summary just invites a choice. */
  ready: boolean;
  /** The live line from liveSummaryLine (parts joined by " · "). */
  line: string;
  sheets: number | null;
  /** Small inline lines (what a tap switched, blank pages added, "confirmed after you press Print"). */
  notes?: ReactNode;
  error?: ReactNode;
  className?: string;
  /** The Print button (or the booklet-question pointer). */
  children: ReactNode;
}) {
  return (
    <div
      data-testid="print-summary"
      className={`sticky bottom-[var(--sticky-bottom,0.75rem)] z-30 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-3 shadow-[var(--shadow-pop)] backdrop-blur lg:bottom-auto lg:p-5 lg:shadow-[var(--shadow-card)] ${className}`}
    >
      <div className="flex items-center gap-3 lg:flex-col lg:items-stretch lg:gap-4">
        <div aria-live="polite" className="min-w-0 flex-1">
          <p className="hidden text-xs font-medium uppercase tracking-wide text-[var(--color-faint)] lg:block">Your print</p>
          {ready ? (
            <p className="text-sm font-medium leading-5 text-[var(--color-text)] lg:mt-1 lg:text-base lg:leading-6">{line.split(" · ").map((part, i) => (
                <span key={part}>
                  {i > 0 ? ", " : ""}
                  <span className="whitespace-nowrap">{part}</span>
                </span>
              ))}</p>
          ) : (
            <p className="text-sm leading-5 text-[var(--color-muted)] lg:mt-1 lg:text-base">Choose a PDF or photo to get started.</p>
          )}
          {sheets !== null && (
            <p className="mt-0.5 text-[13px] leading-5 tabular-nums text-[var(--color-muted)]">
              {sheets} {sheets === 1 ? "sheet" : "sheets"}
              <span className="text-[var(--color-faint)]"> · estimate</span>
            </p>
          )}
        </div>
        <div className="shrink-0 lg:shrink">{children}</div>
      </div>
      {notes}
      {error && <div className="mt-2">{error}</div>}
    </div>
  );
}
