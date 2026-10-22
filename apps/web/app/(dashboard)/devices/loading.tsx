import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Skeleton className="mb-1 h-7 w-48" />
      <Skeleton className="mb-6 h-4 w-72" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-40" />
      </div>
    </main>
  );
}
