import { Skeleton, SkeletonHeader } from "@/components/ui";

export default function Loading() {
  return (
    <div>
      <SkeletonHeader />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-[var(--radius-card)]" />
        ))}
      </div>
    </div>
  );
}
