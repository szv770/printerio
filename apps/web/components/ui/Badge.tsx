const TONE_CLASSES = {
  neutral: "bg-[var(--color-surface-2)] text-[var(--color-text-2)]",
  accent: "bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success-ink)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger-ink)]",
} as const;

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: keyof typeof TONE_CLASSES }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium leading-5 whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
