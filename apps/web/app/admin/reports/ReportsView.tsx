import Link from "next/link";
import { AlertTriangle, Building2, CalendarDays, FileText, Info, Palette, Printer, Users } from "lucide-react";
import {
  Collapsible,
  EmptyState,
  PageHeader,
  Pills,
  ResponsiveTable,
  StatCard,
  StatusDot,
  Tabs,
  type TableColumn,
} from "@/components/ui";
import { LocalTime } from "@/app/(dashboard)/jobs/LocalTime";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { jobStatusTone } from "@/lib/admin/all-jobs";
import { REPORT_RANGES, type ReportRange } from "@/lib/admin/reports-view";
import { reportTabs } from "@/lib/admin/tabs";
import { routes } from "@/lib/routes";
import { ExportCsvButton } from "./ExportCsvButton";

/** The tables show the top rows only; the CSV export always has everyone. */
export const REPORT_TABLE_ROWS = 25;

export interface ReportRow {
  key: string;
  label: string;
  jobCount: number;
  sheets: number;
}

export interface ReportProblem {
  id: string;
  who: string;
  status: string;
  createdAt: string;
}

export interface ReportMonth {
  period: string;
  pdfPages: number;
  printedSides: number;
  physicalSheets: number;
  colorWeighted: number;
}

export interface ReportsViewProps {
  range: ReportRange;
  isOrgAdmin: boolean;
  stats: { sheets: number; jobs: number; colorPct: number | null; problems: number };
  /** "Showing the first 1,000 rows" when the job read hit its cap, else null. */
  truncated: string | null;
  byUser: ReportRow[];
  byDepartment: ReportRow[];
  byPrinter: ReportRow[];
  problems: ReportProblem[];
  months: ReportMonth[];
  thisPeriod: string;
  color: { colorJobs: number; colorSheets: number; bwJobs: number; bwSheets: number };
}

const n = (v: number) => v.toLocaleString("en-US");

function topSummary(rows: ReportRow[], empty: string): string {
  const top = rows[0];
  return top ? `Top: ${top.label}, ${n(top.sheets)} sheets` : empty;
}

function rowColumns(first: string): TableColumn<ReportRow>[] {
  return [
    { header: first, primary: true, cell: (r) => r.label },
    { header: "Jobs", align: "right", cell: (r) => n(r.jobCount) },
    { header: "Sheets", align: "right", cell: (r) => n(r.sheets) },
  ];
}

function RowsTable({ title, first, rows }: { title: string; first: string; rows: ReportRow[] }) {
  const shown = rows.slice(0, REPORT_TABLE_ROWS);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <ExportCsvButton
          filename={title}
          columns={[first, "Jobs", "Sheets"]}
          rows={rows.map((r) => [r.label, String(r.jobCount), String(r.sheets)])}
        />
      </div>
      <ResponsiveTable columns={rowColumns(first)} rows={shown} rowKey={(r) => r.key} caption={title} />
      {rows.length > shown.length && (
        <p className="text-[13px] text-[var(--color-muted)]">
          Showing the top {shown.length} of {n(rows.length)}. The export has everyone.
        </p>
      )}
    </div>
  );
}

export function ReportsView(p: ReportsViewProps) {
  const rangeLabel = REPORT_RANGES.find((r) => r.days === p.range)?.label.toLowerCase() ?? "";
  const problemColumns: TableColumn<ReportProblem>[] = [
    { header: "Who", primary: true, cell: (j) => j.who },
    {
      header: "What happened",
      cell: (j) => <StatusDot tone={jobStatusTone(j.status)}>{jobStatusDisplay(j.status).label}</StatusDot>,
    },
    { header: "When", cell: (j) => <LocalTime iso={j.createdAt} /> },
  ];
  const monthColumns: TableColumn<ReportMonth>[] = [
    { header: "Month", primary: true, cell: (m) => (m.period === p.thisPeriod ? `${m.period} (now)` : m.period) },
    { header: "Pages", align: "right", cell: (m) => n(m.pdfPages) },
    { header: "Sheets", align: "right", cell: (m) => n(m.physicalSheets) },
    { header: "Printed sides", align: "right", hideOnPhone: true, cell: (m) => n(m.printedSides) },
    { header: "Color-weighted", align: "right", hideOnPhone: true, cell: (m) => n(m.colorWeighted) },
  ];
  const colorRows = [
    { mode: "Color", jobs: p.color.colorJobs, sheets: p.color.colorSheets },
    { mode: "Black and white", jobs: p.color.bwJobs, sheets: p.color.bwSheets },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Reports" description="See how much your printers were used, and by whom." />
      <Tabs label="Reports" items={reportTabs("usage", p.isOrgAdmin)} />

      <div className="-mt-3 flex flex-col gap-3">
        <Pills
          label="Time range"
          items={REPORT_RANGES.map((r) => ({
            href: `${routes.adminReports}?range=${r.days}`,
            label: r.label,
            active: r.days === p.range,
          }))}
        />
        {p.truncated && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-[var(--color-warning-ink)]">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            {p.truncated}. The numbers below only count those rows.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-tour="admin-reports-stats">
        <StatCard label="Sheets printed" value={n(p.stats.sheets)} note={rangeLabel} icon={<Printer className="h-4 w-4" />} tone="cyan" />
        <StatCard label="Jobs" value={n(p.stats.jobs)} note={rangeLabel} icon={<FileText className="h-4 w-4" />} />
        <StatCard
          label="Color"
          value={p.stats.colorPct === null ? "-" : `${p.stats.colorPct}%`}
          note="of sheets printed"
          icon={<Palette className="h-4 w-4" />}
          tone="magenta"
        />
        <StatCard
          label="Failed or denied"
          value={n(p.stats.problems)}
          note={rangeLabel}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={p.stats.problems > 0 ? "yellow" : "green"}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Collapsible
          id="problems"
          title="Failed or denied jobs"
          icon={<AlertTriangle className="h-4 w-4" />}
          summary={p.problems.length === 0 ? "Nothing failed" : `${n(p.problems.length)} to look at`}
        >
          {p.problems.length === 0 ? (
            <EmptyState icon={Info} message="Nothing failed or was denied in this time." />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <Link href={`${routes.adminJobs}?status=failed`} className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-primary)] hover:underline">
                  See failed jobs
                </Link>
                <ExportCsvButton
                  filename="failed-or-denied"
                  columns={["User", "What happened", "Date"]}
                  rows={p.problems.map((j) => [j.who, jobStatusDisplay(j.status).label, new Date(j.createdAt).toLocaleDateString()])}
                />
              </div>
              <ResponsiveTable columns={problemColumns} rows={p.problems} rowKey={(j) => j.id} caption="Failed or denied jobs" />
            </div>
          )}
        </Collapsible>

        <Collapsible id="by-user" title="By user" icon={<Users className="h-4 w-4" />} summary={topSummary(p.byUser, "No jobs in this time")}>
          {p.byUser.length === 0 ? <EmptyState icon={Info} message="No jobs in this time." /> : <RowsTable title="Usage by user" first="User" rows={p.byUser} />}
        </Collapsible>

        <Collapsible id="by-department" title="By department" icon={<Building2 className="h-4 w-4" />} summary={topSummary(p.byDepartment, "No departments yet")}>
          {p.byDepartment.length === 0 ? (
            <EmptyState icon={Info} message="No jobs from a department in this time." />
          ) : (
            <RowsTable title="Usage by department" first="Department" rows={p.byDepartment} />
          )}
        </Collapsible>

        <Collapsible id="by-printer" title="By printer" icon={<Printer className="h-4 w-4" />} summary={topSummary(p.byPrinter, "No jobs in this time")}>
          {p.byPrinter.length === 0 ? <EmptyState icon={Info} message="No jobs in this time." /> : <RowsTable title="Usage by printer" first="Printer" rows={p.byPrinter} />}
        </Collapsible>

        <Collapsible id="months" title="Month by month" icon={<CalendarDays className="h-4 w-4" />} summary="Pages and sheets for the last 6 months, plus color">
          <div className="flex flex-col gap-6">
            {p.months.length === 0 ? (
              <EmptyState icon={Info} message="Nothing recorded yet." />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex justify-end">
                  <ExportCsvButton
                    filename="month-by-month"
                    columns={["Month", "Pages", "Printed sides", "Sheets", "Color-weighted"]}
                    rows={p.months.map((m) => [m.period, String(m.pdfPages), String(m.printedSides), String(m.physicalSheets), String(m.colorWeighted)])}
                  />
                </div>
                <ResponsiveTable columns={monthColumns} rows={p.months} rowKey={(m) => m.period} caption="Usage by month" />
              </div>
            )}
            <ResponsiveTable
              caption="Color and black and white"
              columns={[
                { header: "Kind", primary: true, cell: (r: (typeof colorRows)[number]) => r.mode },
                { header: "Jobs", align: "right", cell: (r) => n(r.jobs) },
                { header: "Sheets", align: "right", cell: (r) => n(r.sheets) },
              ]}
              rows={colorRows}
              rowKey={(r) => r.mode}
            />
          </div>
        </Collapsible>
      </div>
    </div>
  );
}
