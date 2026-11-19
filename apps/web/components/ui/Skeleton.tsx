/**
 * A softly shimmering placeholder block for route-level loading.tsx files - Next.js
 * shows these instantly during server navigation while a page's data
 * fetches, instead of a blank screen. Size it to match the content it stands in for.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`printio-shimmer rounded-[var(--radius-sm)] ${className}`} />;
}

/** A page heading placeholder (title + one description line). */
export function SkeletonHeader() {
  return (
    <div className="mb-6 space-y-2.5 sm:mb-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  );
}

/** A card-shaped placeholder with `lines` text lines. */
export function SkeletonCard({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)] ${className}`}>
      <Skeleton className="h-5 w-40" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={`h-4 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
        ))}
      </div>
    </div>
  );
}

/** A list/table placeholder: `rows` rows with an avatar-sized dot and two text lines. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-4">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
        </div>
      ))}
    </div>
  );
}
