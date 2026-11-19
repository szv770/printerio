import { Skeleton } from "@/components/ui";

export default function AgentDetailLoading() {
  return (
    <div className="max-w-4xl" aria-busy="true" aria-label="Loading print server">
      <Skeleton className="mb-4 h-5 w-40" />
      <Skeleton className="mb-1 h-8 w-64" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <div className="flex flex-col gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    </div>
  );
}
