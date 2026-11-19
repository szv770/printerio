import { CheckCircle2, HelpCircle, Lightbulb, ListChecks } from "lucide-react";
import type { HelpPage } from "@/lib/help-content";

/** One page's help, laid out the same in the Help window and in the "?" window. */
export function PageHelp({ page, generic = false }: { page: HelpPage; generic?: boolean }) {
  return (
    <div className="flex flex-col gap-5 text-[15px] leading-6 text-[var(--color-text-2)]">
      <section aria-labelledby="help-what">
        <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-primary)] uppercase" id="help-what">
          <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />
          What this page is
        </p>
        <p className="text-[var(--color-text)]">{page.what}</p>
      </section>

      <section aria-labelledby="help-first">
        <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-primary)] uppercase" id="help-first">
          <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
          Do this first
        </p>
        <ol className="flex flex-col gap-2.5">
          {page.first.map((step, i) => (
            <li key={step} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[13px] font-semibold text-[var(--color-primary)]" aria-hidden="true">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="help-done" className="rounded-[var(--radius-control)] bg-[var(--color-success-soft)] px-4 py-3">
        <p className="mb-0.5 flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-success-ink)] uppercase" id="help-done">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          You are done when
        </p>
        <p className="text-[var(--color-success-ink)]">{page.done}</p>
      </section>

      {page.problems.length > 0 && (
        <section aria-labelledby="help-problems">
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-primary)] uppercase" id="help-problems">
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
            Common problems
          </p>
          <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-control)] border border-[var(--color-border)]">
            {page.problems.map((p) => (
              <details key={p.question} className="group px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 font-medium text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]">
                  {p.question}
                  <span aria-hidden="true" className="mt-0.5 text-[var(--color-faint)] transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none">+</span>
                </summary>
                <p className="mt-1.5 text-[var(--color-muted)]">{p.answer}</p>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
