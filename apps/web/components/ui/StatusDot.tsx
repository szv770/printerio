const DOT = {
  neutral: "bg-[var(--color-faint)]",
  live: "bg-[var(--ink-c)]",
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--ink-y)]",
  danger: "bg-[var(--ink-m)]",
} as const;

export type StatusTone = keyof typeof DOT;

/**
 * Status as a small colored dot plus a word (never color alone). "live" is the
 * cyan, gently pulsing dot for something moving right now. The dot colors are
 * the printer inks: cyan = in motion, yellow = waiting, magenta = problem.
 */
export function StatusDot({ tone = "neutral", children }: { tone?: StatusTone; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium whitespace-nowrap text-[var(--color-text-2)]">
      <span className="relative flex h-2.5 w-2.5">
        {tone === "live" && (
          <span className={`absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:animate-none ${DOT.live}`} />
        )}
        <span className={`relative h-2.5 w-2.5 rounded-full ${DOT[tone]}`} />
      </span>
      {children}
    </span>
  );
}
