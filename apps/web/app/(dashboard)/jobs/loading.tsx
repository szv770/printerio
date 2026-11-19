import { Skeleton, SkeletonHeader } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <SkeletonHeader />
      {/* The filter strip, then rows that now carry a status pill and a stage bar. */}
      <Skeleton className="mb-4 h-8 w-72 max-w-full" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full rounded-[var(--radius-card)]" />
        <Skeleton className="h-24 w-full rounded-[var(--radius-card)]" />
        <Skeleton className="h-24 w-full rounded-[var(--radius-card)]" />
        <Skeleton className="h-24 w-full rounded-[var(--radius-card)]" />
      </div>
    </main>
  );
}
