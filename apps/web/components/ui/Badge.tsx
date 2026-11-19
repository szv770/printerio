const TONE_CLASSES = {
  neutral: "bg-[var(--color-surface-2)] text-[var(--color-text-2)] ring-[var(--color-border-strong)]/50",
  accent: "bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)] ring-[var(--color-primary)]/15",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success-ink)] ring-[var(--color-success)]/15",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)] ring-[var(--color-warning)]/20",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger-ink)] ring-[var(--color-danger)]/15",
} as const;

const DOT_CLASSES = {
  neutral: "bg-[var(--color-faint)]",
  accent: "bg-[var(--ink-c)]",
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--ink-y)]",
  danger: "bg-[var(--ink-m)]",
} as const;

/** A calm tinted label. `dot` adds the matching ink-coloured dot (status pills). */
export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONE_CLASSES;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium leading-5 tabular-nums ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASSES[tone]}`} />}
      {children}
    </span>
  );
}
