import Link from "next/link";
import { JobStatusBadge } from "@/app/(dashboard)/jobs/JobStatusBadge";
import { EmptyState } from "@/components/ui";

export interface RecentJobRow {
  id: string;
  href: string;
  name: string;
  status: string;
  errorMessage?: string | null;
  meta: string;
}

/** Job rows: name, a small line under it, status dot + word. Tap to open. */
export function RecentJobs({ jobs, emptyText }: { jobs: RecentJobRow[]; emptyText: string }) {
  if (jobs.length === 0) return <EmptyState message={emptyText} />;
  return (
    <ul className="flex flex-col gap-2">
      {jobs.map((j) => (
        <li key={j.id}>
          <Link
            href={j.href}
            className="flex min-h-16 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{j.name}</span>
              <span className="block truncate text-xs text-[var(--color-muted)]">{j.meta}</span>
            </span>
            <span className="shrink-0">
              <JobStatusBadge status={j.status} errorMessage={j.errorMessage} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
