"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import { Button } from "./Button";
import { useBeforeUnload } from "./useDirtyForm";

/**
 * The unsaved-changes bar. Appears only while there is something to save (or
 * to report): "You have unsaved changes" with Save and Discard, a spinner while
 * saving, a brief "Saved" afterwards, and the error summary if a save failed.
 *
 * Phones: full-width strip stuck to the bottom edge, padded for the iOS home
 * indicator. md and up: a floating pill at bottom-centre. Escape does nothing
 * on purpose - leaving edits behind must be a deliberate click on Discard.
 * It also asks the browser to confirm before the page is closed or reloaded.
 *
 * Give the page content at least `pb-40` (SAVE_BAR_CLEARANCE) so the bar never
 * covers the last field.
 */
export const SAVE_BAR_CLEARANCE = "pb-40 md:pb-28";

export function SaveBar({
  dirty,
  saving = false,
  savedAt = null,
  error,
  onSave,
  onDiscard,
  changeCount,
}: {
  dirty: boolean;
  saving?: boolean;
  /** Set to a new value (e.g. an incrementing counter) after each successful save to flash "Saved". */
  savedAt?: number | null;
  /** Summary of what failed; the field-level messages live next to the fields. */
  error?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  /** Optional: how many sections changed, shown as "2 sections changed". */
  changeCount?: number;
}) {
  useBeforeUnload(dirty || saving);

  const [dismissedSavedAt, setDismissedSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setDismissedSavedAt(savedAt), 2600);
    return () => clearTimeout(t);
  }, [savedAt]);

  const showSaved = savedAt != null && dismissedSavedAt !== savedAt && !dirty && !saving && !error;
  if (!dirty && !saving && !showSaved && !error) return null;

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="printio-rise fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-pop)] md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[min(34rem,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-full md:border md:py-2.5 md:pr-2.5 md:pl-5"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-3 md:max-w-none md:flex-row md:items-center md:justify-between">
        <div aria-live="polite" className="min-w-0 text-sm">
          {showSaved ? (
            <p className="flex items-center gap-2 font-medium text-[var(--color-success)]">
              <Check className="h-4 w-4" aria-hidden="true" /> Saved
            </p>
          ) : error ? (
            <p role="alert" className="flex items-start gap-2 font-medium text-[var(--color-danger)]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : (
            <p className="font-medium text-[var(--color-text)]">
              You have unsaved changes
              {changeCount && changeCount > 1 ? (
                <span className="font-normal text-[var(--color-muted)]"> ({changeCount} sections)</span>
              ) : null}
            </p>
          )}
        </div>
        {(dirty || saving || error) && !showSaved && (
          <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
            <Button variant="ghost" onClick={onDiscard} disabled={saving} className="md:min-w-24">
              Discard
            </Button>
            <Button onClick={onSave} pending={saving} pendingLabel="Saving..." className="md:min-w-28">
              Save changes
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
