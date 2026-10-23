import type { ReactNode } from "react";

const TONE = {
  neutral: "bg-[var(--color-surface-2)] text-[var(--color-text-2)]",
  cyan: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  magenta: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  yellow: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  green: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
} as const;

/** One big number with a plain label and an optional icon chip; used in summary rows at the top of a page. */
export function StatCard({
  label,
  value,
  note,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
  tone?: keyof typeof TONE;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] leading-5 text-[var(--color-muted)]">{label}</p>
        {icon && <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${TONE[tone]}`}>{icon}</span>}
      </div>
      <p className="mt-1 text-2xl leading-8 font-bold tracking-[-0.02em] tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs leading-4 text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}
