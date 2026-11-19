import { Skeleton, SkeletonHeader } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <SkeletonHeader />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-full rounded-[var(--radius-control)]" />
        <Skeleton className="h-20 w-full rounded-[var(--radius-card)]" />
        <Skeleton className="h-20 w-full rounded-[var(--radius-card)]" />
      </div>
    </main>
  );
}
