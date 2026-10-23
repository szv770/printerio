import { StatusDot } from "@/components/ui";
import type { RightNowRow } from "@/lib/home/admin-home";

export function RightNow({ rows }: { rows: RightNowRow[] }) {
  return (
    <section aria-labelledby="now" className="mb-6">
      <h2 id="now" className="mb-3 text-base font-bold tracking-[-0.01em]">
        Right now
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No printers or print servers are set up yet.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((l) => (
            <li
              key={`${l.kind}-${l.key}`}
              className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 shadow-[var(--shadow-xs)]"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{l.name}</span>
                <span className="block truncate text-xs text-[var(--color-muted)]">{l.detail}</span>
              </span>
              <StatusDot tone={l.tone}>{l.word}</StatusDot>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
