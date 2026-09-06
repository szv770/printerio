/**
 * A pulsing placeholder block for route-level loading.tsx files - Next.js
 * shows these instantly during server navigation while a page's data
 * fetches, instead of a blank screen, which is most of what "feels fast"
 * actually comes down to on a server-rendered app like this one.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-gray-100 ${className}`} />;
}
