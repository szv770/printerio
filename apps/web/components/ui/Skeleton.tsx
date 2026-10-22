/**
 * A pulsing placeholder block for route-level loading.tsx files - Next.js
 * shows these instantly during server navigation while a page's data
 * fetches, instead of a blank screen.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-[var(--color-surface-2)] motion-reduce:animate-none ${className}`} />;
}
