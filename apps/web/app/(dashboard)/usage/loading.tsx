import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Skeleton className="mb-1 h-7 w-32" />
      <Skeleton className="mb-6 h-4 w-56" />
      <Skeleton className="h-28 w-full" />
    </main>
  );
}
