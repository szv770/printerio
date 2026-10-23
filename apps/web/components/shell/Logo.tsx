/**
 * The Printio mark: a sheet of paper with a folded corner, with three ink dots
 * (cyan, magenta, yellow) printed on it, on the accent tile. Inline SVG, so it
 * is crisp at any size and needs no asset. app/icon.tsx draws the same shapes
 * for the favicon.
 */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect width="28" height="28" rx="8.5" fill="#0a64d8" />
      <path d="M8.5 5.5h8.2l4.8 4.8V22a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 22V7a1.5 1.5 0 0 1 1.5-1.5Z" fill="#fffefc" />
      <path d="M16.7 5.5v3.3a1.5 1.5 0 0 0 1.5 1.5h3.3Z" fill="#b9d3f5" />
      <circle cx="11" cy="18.3" r="1.55" fill="#0ea5d9" />
      <circle cx="14.3" cy="18.3" r="1.55" fill="#e03a86" />
      <circle cx="17.6" cy="18.3" r="1.55" fill="#f4b400" />
    </svg>
  );
}

/** Mark plus the wordmark. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-[17px] font-bold tracking-[-0.03em] text-[var(--color-text)]">Printio</span>
    </span>
  );
}
