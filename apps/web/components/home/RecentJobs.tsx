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
    <ul className="flex flex-col gap-2.5">
      {jobs.map((j) => (
        <li key={j.id}>
          <Link
            href={j.href}
            className="flex min-h-16 items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-card)] transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-hover)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold sm:text-[15px]">{j.name}</span>
              <span className="mt-0.5 block truncate text-xs text-[var(--color-muted)]">{j.meta}</span>
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
