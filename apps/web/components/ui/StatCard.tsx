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
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-5 text-[var(--color-muted)]">{label}</p>
        {icon && <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${TONE[tone]}`}>{icon}</span>}
      </div>
      <p className={`mt-1.5 font-semibold tracking-[-0.025em] tabular-nums ${typeof value === "string" && value.length > 9 ? "text-lg leading-8 sm:text-xl" : "text-2xl leading-8"}`}>{value}</p>
      {note && <p className="mt-1 text-xs leading-4 text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}
