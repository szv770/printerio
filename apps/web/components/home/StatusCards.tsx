import { Card } from "@/components/ui";
import type { StatusCard } from "@/lib/home/teacher-home";

export function StatusCards({ cards }: { cards: StatusCard[] }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3">
      {cards.map((c) => (
        <Card key={c.id} className="p-4 sm:p-4" data-tour={c.id === "quota" ? "home-quota" : undefined}>
          <p className="text-[13px] text-[var(--color-muted)]">{c.label}</p>
          <p className="mt-1 text-2xl font-bold tracking-[-0.02em] tabular-nums">{c.value}</p>
          {c.percentLeft !== undefined && (
            <div
              className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
              role="img"
              aria-label={`${c.percentLeft}% of your allowance left`}
            >
              <div className="h-full rounded-full bg-[var(--ink-c)]" style={{ width: `${c.percentLeft}%` }} />
            </div>
          )}
          {c.note && <p className="mt-2.5 text-xs text-[var(--color-faint)]">{c.note}</p>}
        </Card>
      ))}
    </div>
  );
}
