import { StatusDot } from "@/components/ui";
import type { RightNowRow } from "@/lib/home/admin-home";

export function RightNow({ rows }: { rows: RightNowRow[] }) {
  return (
    <section aria-labelledby="now" className="mb-6">
      <h2 id="now" className="mb-3 text-[13px] font-semibold tracking-[0.04em] text-[var(--color-muted)] uppercase">
        Right now
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No printers or print servers are set up yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((l) => (
            <li
              key={`${l.kind}-${l.key}`}
              className="flex min-h-16 min-w-0 items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-card)]"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{l.name}</span>
                <span className="mt-0.5 block truncate text-xs text-[var(--color-muted)]">{l.detail}</span>
              </span>
              <StatusDot tone={l.tone}>{l.word}</StatusDot>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
