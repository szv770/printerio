import { Info } from "lucide-react";
import type { QuotaBasis } from "@printio/shared";
import { PageHeader, Card, Collapsible } from "@/components/ui";
import { usageSummary } from "@/lib/usage-summary";

export const BASIS_LABEL: Record<QuotaBasis, string> = {
  pdf_pages: "PDF pages",
  printed_sides: "printed sides",
  physical_sheets: "physical sheets",
  color_weighted: "color-weighted sheets",
};

const BASIS_EXPLAINED: Record<QuotaBasis, string> = {
  pdf_pages: "Every page of your document counts as one, however it is printed.",
  printed_sides: "Every side of paper that gets ink counts as one. Double-sided pages count as two sides per sheet.",
  physical_sheets: "Every sheet of paper counts as one. A double-sided page uses half as many sheets.",
  color_weighted: "Like sheets of paper, but color is weighted so it counts for more than black and white.",
};

/** The "My usage" page body. Presentational (no data access) so the dev preview can render it with sample numbers. */
export function UsageView({ used, limit, basis, period }: { used: number; limit: number | null; basis: QuotaBasis; period: string }) {
  const summary = usageSummary({ used, limit, unit: BASIS_LABEL[basis] });
  const barColor = { success: "bg-[var(--ink-c)]", warning: "bg-[var(--ink-y)]", danger: "bg-[var(--ink-m)]" }[summary.tone];
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">
      <PageHeader title="My usage" description={`This month (${period})`} />
      <div className="flex flex-col gap-3">
        <Card className="flex flex-col gap-4 sm:p-6">
          <div>
            <p className="text-2xl font-semibold leading-8 tracking-[-0.01em] sm:text-3xl sm:leading-9">{summary.headline}</p>
            <p className="mt-1.5 text-[15px] text-[var(--color-muted)]">{summary.detail}</p>
          </div>
          {summary.pct !== null && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={summary.pct}
              aria-label={`${summary.pct}% of your limit used`}
              className="h-3 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
            >
              <div className={`h-full rounded-full ${barColor} transition-[width] duration-500 motion-reduce:transition-none`} style={{ width: `${summary.pct}%` }} />
            </div>
          )}
        </Card>
        <Collapsible
          id="usage-how"
          title="How this is counted"
          icon={<Info className="h-4 w-4" aria-hidden="true" />}
          summary={`Measured in ${BASIS_LABEL[basis]}`}
        >
          <p className="text-sm leading-6 text-[var(--color-text-2)]">{BASIS_EXPLAINED[basis]}</p>
          <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">Your usage starts again from zero at the start of each month.</p>
        </Collapsible>
      </div>
    </main>
  );
}
