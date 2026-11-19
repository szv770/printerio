const DOT = {
  neutral: "bg-[var(--color-faint)] shadow-[0_0_0_3px_rgb(143_137_124/0.16)]",
  live: "bg-[var(--ink-c)] shadow-[0_0_0_3px_rgb(14_165_217/0.18)]",
  success: "bg-[var(--color-success)] shadow-[0_0_0_3px_rgb(21_128_61/0.14)]",
  warning: "bg-[var(--ink-y)] shadow-[0_0_0_3px_rgb(244_180_0/0.22)]",
  danger: "bg-[var(--ink-m)] shadow-[0_0_0_3px_rgb(224_58_134/0.16)]",
} as const;

export type StatusTone = keyof typeof DOT;

/**
 * Status as a small colored dot plus a word (never color alone). "live" is the
 * cyan, gently pulsing dot for something moving right now. The dot colors are
 * the printer inks: cyan = in motion, yellow = waiting, magenta = problem.
 */
export function StatusDot({ tone = "neutral", children }: { tone?: StatusTone; children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 text-[13px] font-medium text-[var(--color-text-2)]">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {tone === "live" && (
          <span className={`absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:animate-none ${DOT.live}`} />
        )}
        <span className={`relative h-2.5 w-2.5 rounded-full ${tone === "live" ? "bg-[var(--ink-c)]" : DOT[tone]}`} />
      </span>
      {children}
    </span>
  );
}
