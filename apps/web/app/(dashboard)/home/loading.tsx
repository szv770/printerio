import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <Skeleton className="mb-6 h-24 w-full" />
      <div className="mb-6 grid grid-cols-2 gap-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="mb-3 h-5 w-32" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </main>
  );
}
