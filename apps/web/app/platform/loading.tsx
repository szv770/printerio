import { Skeleton, SkeletonHeader } from "@/components/ui";

export default function Loading() {
  return (
    <div>
      <SkeletonHeader />
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-[var(--radius-card)]" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 rounded-[var(--radius-card)]" />
        <Skeleton className="h-28 rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}
