import Link from "next/link";
import { CheckCircle2, Circle, Rocket } from "lucide-react";
import { Collapsible } from "@/components/ui";
import { nextSetupStep, setupProgress, type SetupStep } from "@/lib/admin-setup-checklist";

/** First-run checklist, shown only while required setup is unfinished. */
export function SetupCard({ steps }: { steps: SetupStep[] }) {
  const { done, total } = setupProgress(steps);
  const next = nextSetupStep(steps);
  return (
    <div className="mb-6" data-tour="admin-setup">
      <Collapsible
        id="finish-setup"
        title="Finish setting up"
        icon={<Rocket className="h-4 w-4" aria-hidden="true" />}
        badge={
          <span className="text-[13px] font-medium text-[var(--color-muted)]">
            {done} of {total}
          </span>
        }
        summary={next ? `Next: ${next.title}` : undefined}
        defaultOpen
      >
        <ol className="flex flex-col gap-3">
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-3">
              {s.done ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" aria-label="Done" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-faint)]" aria-label="Not done" />
              )}
              <div className="min-w-0 flex-1">
                <p className={`text-[15px] font-medium ${s.done ? "text-[var(--color-muted)] line-through" : ""}`}>
                  {s.title}
                  {s.optional && <span className="ml-2 text-xs font-normal text-[var(--color-faint)]">Optional</span>}
                </p>
                {!s.done && <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">{s.description}</p>}
              </div>
              {!s.done && (
                <Link href={s.href} className="shrink-0 text-sm font-medium text-[var(--color-primary)]">
                  Open
                </Link>
              )}
            </li>
          ))}
        </ol>
      </Collapsible>
    </div>
  );
}
