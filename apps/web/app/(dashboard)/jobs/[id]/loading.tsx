import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Skeleton className="mb-1 h-7 w-64" />
      <Skeleton className="mb-6 h-4 w-32" />
      {/* Matches the shape of the status card + stage list that lands here, so
       *  the page doesn't visibly jump once the job loads. */}
      <Skeleton className="h-72 w-full" />
      <Skeleton className="mt-4 h-32 w-full" />
    </main>
  );
}
