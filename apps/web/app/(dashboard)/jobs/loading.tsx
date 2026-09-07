import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Skeleton className="mb-1 h-7 w-40" />
      <Skeleton className="mb-4 h-4 w-56" />
      {/* The filter strip, then rows that now carry a status pill and a stage bar. */}
      <Skeleton className="mb-4 h-8 w-72" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </main>
  );
}
