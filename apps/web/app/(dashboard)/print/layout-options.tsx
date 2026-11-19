"use client";

import { Check, Scissors } from "lucide-react";
import { Card, Switch, Segmented } from "@/components/ui";
import { PRINT_PRESETS, type PrintPreset } from "@printio/shared";
import { NO_LAYOUT, layoutFromUi, layoutSummary, presetIsSelected, type LayoutUi } from "@/lib/print-layout-form";

/**
 * "Quick settings": one tap fills the booklet and Layout controls from a built-in preset (the same ones the phones get
 * from the print dialog's paper type). The selected look is derived from the form, so changing a control by hand clears it.
 * Presentational only: the form owns the state (lib/print-layout-form.ts has the rules).
 */
export function QuickSettings({
  presets = PRINT_PRESETS,
  booklet,
  layout,
  onPick,
}: {
  presets?: readonly PrintPreset[];
  booklet: string;
  layout: LayoutUi;
  onPick: (preset: PrintPreset) => void;
}) {
  if (presets.length === 0) return null;
  return (
    <section aria-labelledby="quick-settings-title" data-testid="quick-settings">
      <h2 id="quick-settings-title" className="mb-2 text-sm font-medium">
        Quick settings
      </h2>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => {
          const selected = presetIsSelected(p, booklet, layout);
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected}
              title={p.description}
              onClick={() => onPick(p)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
                selected
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                  : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {p.mediaTypeName}
            </button>
          );
        })}
      </div>
    </section>
  );
}

type PerSheet = "1" | "2" | "4";
type RepeatCopies = "off" | "2" | "4";

/**
 * The Layout section: pages per sheet (1, 2, 4) or one page repeated on the sheet (2 or 4 copies, with cut marks).
 * Disabled with a plain reason while a booklet is chosen (a booklet is its own layout); the booklet control does the same the other way.
 * The summary line is an ESTIMATE from the browser's page count; the server counts again.
 */
export function LayoutOptions({
  value,
  onChange,
  bookletOn,
  pages,
  duplex,
}: {
  value: LayoutUi;
  onChange: (next: LayoutUi) => void;
  bookletOn: boolean;
  /** The pages that will print as far as the browser knows (an image is 1); null when unknown. */
  pages: number | null;
  duplex: boolean;
}) {
  const perSheet: PerSheet = value.mode === "nup" ? (String(value.perSheet) as PerSheet) : "1";
  const repeat: RepeatCopies = value.mode === "repeat" ? (String(value.copies) as RepeatCopies) : "off";
  const summary = layoutSummary(layoutFromUi(value), pages, duplex);
  const why = "Turn off Booklet to use this.";

  return (
    <Card className="flex flex-col gap-5" data-tour="print-layout">
      <div>
        <h2 className="text-sm font-medium">Layout</h2>
        <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Put more than one page on each sheet.</p>
      </div>
      {bookletOn && (
        <p role="status" className="rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-muted)]">
          A booklet already arranges the pages, so these are off. Turn off Booklet above to use them.
        </p>
      )}
      <Segmented<PerSheet>
        label="Pages per sheet"
        value={perSheet}
        onChange={(v) => onChange(v === "1" ? { ...value, mode: "none" } : { ...value, mode: "nup", perSheet: v === "2" ? 2 : 4 })}
        options={[
          { value: "1", label: "1", disabledReason: bookletOn ? why : null },
          { value: "2", label: "2", disabledReason: bookletOn ? why : null },
          { value: "4", label: "4", disabledReason: bookletOn ? why : null },
        ]}
      />
      <div>
        <Segmented<RepeatCopies>
          label="Repeat each page on the sheet"
          value={repeat}
          onChange={(v) => onChange(v === "off" ? { ...value, mode: "none" } : { ...value, mode: "repeat", copies: v === "2" ? 2 : 4 })}
          options={[
            { value: "off", label: "Off", disabledReason: bookletOn ? why : null },
            { value: "2", label: "2 copies", disabledReason: bookletOn ? why : null },
            { value: "4", label: "4 copies", disabledReason: bookletOn ? why : null },
          ]}
        />
        {value.mode === "repeat" && (
          <div className="mt-3">
            <Switch
              label="Cut marks"
              description="Print, then cut along the marks."
              checked={value.marks}
              onChange={(e) => onChange({ ...value, marks: e.target.checked })}
            />
          </div>
        )}
      </div>
      {summary && !bookletOn && (
        <p role="status" data-testid="layout-summary" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-[var(--color-primary-soft)]/60 px-3 py-2.5 text-sm font-medium">
          {value.mode === "repeat" && <Scissors className="h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />}
          <span>{summary}</span>
          {pages !== null && <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs font-normal text-[var(--color-muted)]">estimate</span>}
        </p>
      )}
    </Card>
  );
}

export { NO_LAYOUT };
