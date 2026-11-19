"use client";

import { Check, LayoutGrid, Scissors } from "lucide-react";
import { Select, Switch, Segmented } from "@/components/ui";
import { InlineNote, SettingsGroup } from "./SettingsGroup";
import { PRINT_PRESETS, type PrintPreset } from "@printio/shared";
import { NO_LAYOUT, layoutFromUi, layoutSummary, presetIsSelected, type LayoutUi } from "@/lib/print-layout-form";

/**
 * "Preset": one tap fills the booklet and Layout controls from a built-in preset (the same ones the phones get
 * from the print dialog's paper type). On a phone it is ONE scrolling row of chips; from sm up it is a single dropdown
 * (the five names are long, so chips would wrap). The selected look is derived from the form, so changing a control by
 * hand clears it. Presentational only: the form owns the state (lib/print-layout-form.ts has the rules).
 */
export function QuickSettings({
  presets = PRINT_PRESETS,
  booklet,
  layout,
  onPick,
  onClear,
}: {
  presets?: readonly PrintPreset[];
  booklet: string;
  layout: LayoutUi;
  onPick: (preset: PrintPreset) => void;
  /** Chosen from the dropdown's "No preset" entry: back to a plain print (booklet off, one page per sheet). */
  onClear?: () => void;
}) {
  if (presets.length === 0) return null;
  const current = presets.find((p) => presetIsSelected(p, booklet, layout));
  return (
    <section aria-labelledby="quick-settings-title" data-testid="quick-settings">
      <h2 id="quick-settings-title" className="mb-2 text-[13px] font-medium text-[var(--color-muted)]">
        Quick settings
      </h2>
      <div className="-mx-4 flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden">
        {presets.map((p) => {
          const selected = p.id === current?.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected}
              title={p.description}
              onClick={() => onPick(p)}
              className={`inline-flex min-h-11 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring)] motion-reduce:transition-none ${
                selected
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-2)] hover:border-[var(--color-border-strong)]"
              }`}
            >
              {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {p.mediaTypeName}
            </button>
          );
        })}
      </div>
      <div className="hidden sm:block">
        <label htmlFor="preset-select" className="sr-only">
          Quick settings
        </label>
        <Select
          id="preset-select"
          className="!min-h-11"
          value={current?.id ?? ""}
          onChange={(e) => {
            const next = presets.find((p) => p.id === e.target.value);
            if (next) onPick(next);
            else onClear?.();
          }}
        >
          <option value="">No preset</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.mediaTypeName}
            </option>
          ))}
        </Select>
        {current && <p className="mt-1.5 text-[13px] leading-5 text-[var(--color-muted)]">{current.description}</p>}
      </div>
    </section>
  );
}

type PerSheet = "1" | "2" | "4";
type RepeatCopies = "off" | "2" | "4";

/**
 * The Layout group: pages per sheet (1, 2, 4) or one page repeated on the sheet (2 or 4 copies, with cut marks).
 * Disabled with a plain reason while a booklet is chosen (a booklet is its own layout); the booklet control does the same the other way.
 * The estimate line is an ESTIMATE from the browser's page count; the server counts again.
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
  const active = !bookletOn && value.mode !== "none";
  const headline = bookletOn
    ? "Off while a booklet is on"
    : value.mode === "nup"
      ? `${value.perSheet} pages per sheet`
      : value.mode === "repeat"
        ? `Each page ${value.copies} times on a sheet`
        : "One page per sheet";

  return (
    <SettingsGroup id="print-layout" title="Layout" icon={<LayoutGrid className="h-[18px] w-[18px]" aria-hidden="true" />} summary={headline} changed={active} dataTour="print-layout">
      {bookletOn && (
        <InlineNote>A booklet already arranges the pages, so these are off. Turn off Booklet to use them.</InlineNote>
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
      <div className="flex flex-col gap-3">
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
          <Switch
            label="Cut marks"
            description="Print, then cut along the marks."
            checked={value.marks}
            onChange={(e) => onChange({ ...value, marks: e.target.checked })}
          />
        )}
      </div>
      {summary && !bookletOn && (
        <InlineNote tone="accent" data-testid="layout-summary" icon={value.mode === "repeat" ? <Scissors className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" /> : undefined}>
          {summary}
          {pages !== null && <span className="text-[var(--color-faint)]"> · estimate</span>}
        </InlineNote>
      )}
    </SettingsGroup>
  );
}

export { NO_LAYOUT };
