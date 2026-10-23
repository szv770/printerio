import Link from "next/link";
import { ChevronLeft, Search, Layers } from "lucide-react";
import { Button, ButtonLink, EmptyState, Input, PageHeader, Pills, ResponsiveTable, StatusDot, type TableColumn } from "@/components/ui";
import { LocalTime } from "@/app/(dashboard)/jobs/LocalTime";
import { JOB_FILTERS, buildJobsHref, jobStatusCell, type JobsQuery } from "@/lib/admin/all-jobs";
import { routes } from "@/lib/routes";

export interface JobListRow {
  id: string;
  jobNumber: string;
  fileName: string;
  who: string;
  status: string;
  pages: number;
  copies: number;
  createdAt: string;
  isTest: boolean;
  errorMessage?: string | null;
}

export function JobsView({ rows, query, hasOlder }: { rows: JobListRow[]; query: JobsQuery; hasOlder: boolean }) {
  const columns: TableColumn<JobListRow>[] = [
    {
      header: "File",
      primary: true,
      cell: (j) => (
        <div className="min-w-0 md:max-w-[22rem]">
          <Link
            href={routes.job(j.id)}
            className="-my-2.5 block py-2.5 font-medium break-words hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ring)] md:truncate"
          >
            {j.fileName}
          </Link>
          <p className="text-[13px] font-normal text-[var(--color-muted)]">
            {j.jobNumber}
            {j.isTest ? " · test page" : ""}
          </p>
        </div>
      ),
    },
    { header: "User", cell: (j) => j.who },
    { header: "Status", cell: (j) => <StatusDot tone={jobStatusCell(j.status, j.errorMessage).tone}>{jobStatusCell(j.status, j.errorMessage).label}</StatusDot> },
    {
      header: "Pages",
      align: "right",
      cell: (j) => (j.copies > 1 ? `${j.pages} x ${j.copies}` : String(j.pages)),
    },
    { header: "Sent", cell: (j) => <LocalTime iso={j.createdAt} /> },
  ];

  const filtered = query.status !== "all" || query.q !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="All jobs" description="Every job sent by anyone, newest first. Open one to see what happened." />

      <div className="-mt-2 flex flex-col gap-3">
        <form method="get" action={routes.adminJobs} role="search" className="flex gap-2">
          {query.status !== "all" && <input type="hidden" name="status" value={query.status} />}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--color-faint)]" aria-hidden="true" />
            <Input name="q" type="search" defaultValue={query.q} placeholder="Search users or files" aria-label="Search jobs by user or file name" className="pl-9" />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <Pills
          label="Filter by status"
          items={JOB_FILTERS.map((f) => ({
            href: buildJobsHref(query, { status: f.value, page: 1 }),
            label: f.label,
            active: f.value === query.status,
          }))}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={filtered ? "No jobs match" : "No jobs yet"}
          description={filtered ? "Try a different search or filter." : "Jobs will show up here as soon as someone prints."}
          action={
            filtered ? (
              <ButtonLink href={routes.adminJobs} variant="secondary">
                Show all jobs
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable columns={columns} rows={rows} rowKey={(j) => j.id} caption="All jobs" />
          <nav aria-label="More jobs" className="flex items-center justify-between gap-3">
            {query.page > 1 ? (
              <ButtonLink href={buildJobsHref(query, { page: query.page - 1 })} variant="ghost" scroll={false}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Newer
              </ButtonLink>
            ) : (
              <span />
            )}
            {hasOlder && (
              <ButtonLink href={buildJobsHref(query, { page: query.page + 1 })} variant="secondary" scroll={false}>
                Show older
              </ButtonLink>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
