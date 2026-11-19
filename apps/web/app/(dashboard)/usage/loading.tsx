import { Skeleton, SkeletonHeader } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <SkeletonHeader />
      <Skeleton className="h-28 w-full rounded-[var(--radius-card)]" />
    </main>
  );
}
