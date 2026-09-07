import { Info } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Card, Badge, EmptyState } from "@/components/ui";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { currentPeriod } from "@/lib/quota";
import { ExportCsvButton } from "./ExportCsvButton";
import {
  aggregateByUser,
  aggregateByDepartment,
  aggregateByPrinter,
  aggregateColorUsage,
  recentRejectedOrFailed,
  aggregatePagesByMonth,
  type ReportJobRow,
  type MonthlyUsageRow,
} from "@/lib/reports";

const JOB_WINDOW_DAYS = 90;
const USAGE_MONTHS = 6;

function monthsAgoPeriod(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function ReportsPage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;

  // Server Component snapshot at request time, not a value React needs to
  // keep referentially stable across re-renders - same rationale as
  // admin/page.tsx's onlineCutoff.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - JOB_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const oldestPeriod = monthsAgoPeriod(USAGE_MONTHS - 1);

  const [{ data: jobRows }, { data: members }, { data: printerRows }, { data: usageRows }] = await Promise.all([
    supabase
      .from("print_jobs")
      .select(
        "id, created_by, color_mode, status, printer_id, estimated_physical_sheets, source_pdf_pages, copies, created_at",
      )
      .eq("organization_id", orgId)
      .gte("created_at", since),
    supabase.from("organization_members").select("user_id, department, profiles(email, display_name)").eq("organization_id", orgId),
    supabase.from("printers").select("id, name").eq("organization_id", orgId),
    supabase
      .from("monthly_usage")
      .select("period, pdf_pages_used, printed_sides_used, physical_sheets_used, color_weighted_used")
      .eq("organization_id", orgId)
      .gte("period", oldestPeriod),
  ]);

  const departmentByUser = new Map((members ?? []).map((m) => [m.user_id, m.department]));
  const labelByUser = new Map(
    (members ?? []).map((m) => [m.user_id, m.profiles?.display_name ?? m.profiles?.email ?? m.user_id]),
  );
  const nameByPrinter = new Map((printerRows ?? []).map((p) => [p.id, p.name]));

  const jobs: ReportJobRow[] = (jobRows ?? []).map((j) => ({
    id: j.id,
    createdBy: j.created_by,
    department: departmentByUser.get(j.created_by) ?? null,
    colorMode: j.color_mode,
    status: j.status,
    printerId: j.printer_id,
    estimatedPhysicalSheets: j.estimated_physical_sheets,
    sourcePdfPages: j.source_pdf_pages,
    copies: j.copies,
    createdAt: j.created_at,
  }));

  const usage: MonthlyUsageRow[] = (usageRows ?? []).map((u) => ({
    period: u.period,
    pdfPagesUsed: u.pdf_pages_used,
    printedSidesUsed: u.printed_sides_used,
    physicalSheetsUsed: u.physical_sheets_used,
    colorWeightedUsed: u.color_weighted_used,
  }));

  const byUser = aggregateByUser(jobs, (id) => labelByUser.get(id) ?? id);
  const byDepartment = aggregateByDepartment(jobs);
  const byPrinter = aggregateByPrinter(jobs, (id) => nameByPrinter.get(id) ?? id);
  const colorUsage = aggregateColorUsage(jobs);
  const rejectedFailed = recentRejectedOrFailed(jobs);
  const pagesByMonth = aggregatePagesByMonth(usage);
  const thisPeriod = currentPeriod();

  // "At a glance" strip - same Card-grid pattern as admin/page.tsx's stats.
  // The full monthly/color tables below are look-up-when-needed reference
  // detail; this is the one-line summary of the same numbers.
  const currentMonth = pagesByMonth.find((m) => m.period === thisPeriod);
  const priorMonth = pagesByMonth.at(-2);
  const monthDeltaPct =
    currentMonth && priorMonth && priorMonth.physicalSheets > 0
      ? Math.round(((currentMonth.physicalSheets - priorMonth.physicalSheets) / priorMonth.physicalSheets) * 100)
      : null;
  const totalSheets = colorUsage.color.sheets + colorUsage.bw.sheets;
  const colorPct = totalSheets > 0 ? Math.round((colorUsage.color.sheets / totalSheets) * 100) : null;

  const stats = [
    {
      label: "Sheets this month",
      value: (currentMonth?.physicalSheets ?? 0).toLocaleString(),
      hint: monthDeltaPct === null ? undefined : `${monthDeltaPct >= 0 ? "▲" : "▼"}${Math.abs(monthDeltaPct)}% vs last month`,
    },
    { label: "Color share", value: colorPct === null ? "—" : `${colorPct}%`, hint: `${JOB_WINDOW_DAYS}d window` },
    { label: "Denied / failed", value: rejectedFailed.length.toLocaleString(), hint: `${JOB_WINDOW_DAYS}d window` },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description={`Job activity over the last ${JOB_WINDOW_DAYS} days and usage over the last ${USAGE_MONTHS} months. "Sheets" only counts jobs that actually reached a printer (completed/printing/submitted_to_spooler) - denied and pending jobs never consumed paper. Tables only for V1 - see docs known-limitations.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-tour="admin-reports-stats">
        {stats.map((s) => (
          <Card key={s.label} className="p-5">
            <p className="text-sm text-[var(--color-muted)]">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold">{s.value}</p>
            {s.hint && <p className="mt-1 text-xs text-[var(--color-muted)]">{s.hint}</p>}
          </Card>
        ))}
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Recently denied / failed</h2>
          {rejectedFailed.length > 0 && (
            <ExportCsvButton
              filename="recently-denied-failed"
              columns={["User", "Status", "Date"]}
              rows={rejectedFailed.map((j) => [
                labelByUser.get(j.createdBy) ?? j.createdBy,
                jobStatusDisplay(j.status).label,
                new Date(j.createdAt).toLocaleDateString(),
              ])}
            />
          )}
        </div>
        {rejectedFailed.length === 0 ? (
          <EmptyState message="No denied or failed jobs in this window." icon={Info} />
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {rejectedFailed.map((j) => {
              const display = jobStatusDisplay(j.status);
              return (
                <li key={j.id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
                  <span>{labelByUser.get(j.createdBy) ?? j.createdBy}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={j.status === "denied" ? "danger" : "warning"}>
                      <span className="flex items-center gap-1">
                        <display.Icon className="h-3.5 w-3.5" />
                        {display.label}
                      </span>
                    </Badge>
                    <span className="text-[var(--color-muted)]">{new Date(j.createdAt).toLocaleDateString()}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">By user ({JOB_WINDOW_DAYS}d)</h2>
          {byUser.length > 0 && (
            <ExportCsvButton
              filename="by-user"
              columns={["User", "Jobs", "Sheets"]}
              rows={byUser.map((r) => [r.label, String(r.jobCount), String(r.sheets)])}
            />
          )}
        </div>
        {byUser.length === 0 ? (
          <EmptyState message="No jobs in this window." icon={Info} />
        ) : (
          <ReportTable
            columns={["User", "Jobs", "Sheets"]}
            rows={byUser.map((r) => [r.label, r.jobCount.toLocaleString(), r.sheets.toLocaleString()])}
          />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">By department ({JOB_WINDOW_DAYS}d)</h2>
            {byDepartment.length > 0 && (
              <ExportCsvButton
                filename="by-department"
                columns={["Department", "Jobs", "Sheets"]}
                rows={byDepartment.map((r) => [r.label, String(r.jobCount), String(r.sheets)])}
              />
            )}
          </div>
          {byDepartment.length === 0 ? (
            <EmptyState message="No department-tagged jobs in this window." icon={Info} />
          ) : (
            <ReportTable
              columns={["Department", "Jobs", "Sheets"]}
              rows={byDepartment.map((r) => [r.label, r.jobCount.toLocaleString(), r.sheets.toLocaleString()])}
            />
          )}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">By printer ({JOB_WINDOW_DAYS}d)</h2>
            {byPrinter.length > 0 && (
              <ExportCsvButton
                filename="by-printer"
                columns={["Printer", "Jobs", "Sheets"]}
                rows={byPrinter.map((r) => [r.label, String(r.jobCount), String(r.sheets)])}
              />
            )}
          </div>
          {byPrinter.length === 0 ? (
            <EmptyState message="No jobs in this window." icon={Info} />
          ) : (
            <ReportTable
              columns={["Printer", "Jobs", "Sheets"]}
              rows={byPrinter.map((r) => [r.label, r.jobCount.toLocaleString(), r.sheets.toLocaleString()])}
            />
          )}
        </Card>
      </div>

      <details className="rounded-xl border border-[var(--color-border)] p-4">
        <summary className="cursor-pointer font-medium">Full history: pages by month &amp; color usage</summary>
        <div className="mt-4 flex flex-col gap-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">Pages by month</h2>
              {pagesByMonth.length > 0 && (
                <ExportCsvButton
                  filename="pages-by-month"
                  columns={["Month", "PDF pages", "Printed sides", "Physical sheets", "Color-weighted"]}
                  rows={pagesByMonth.map((m) => [
                    m.period,
                    String(m.pdfPages),
                    String(m.printedSides),
                    String(m.physicalSheets),
                    String(m.colorWeighted),
                  ])}
                />
              )}
            </div>
            {pagesByMonth.length === 0 ? (
              <EmptyState message="No usage recorded yet." icon={Info} />
            ) : (
              <ReportTable
                columns={["Month", "PDF pages", "Printed sides", "Physical sheets", "Color-weighted"]}
                rows={pagesByMonth.map((m) => [
                  m.period === thisPeriod ? `${m.period} (current)` : m.period,
                  m.pdfPages.toLocaleString(),
                  m.printedSides.toLocaleString(),
                  m.physicalSheets.toLocaleString(),
                  m.colorWeighted.toLocaleString(),
                ])}
              />
            )}
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">Color usage ({JOB_WINDOW_DAYS}d)</h2>
              <ExportCsvButton
                filename="color-usage"
                columns={["Mode", "Jobs", "Sheets"]}
                rows={[
                  ["Color", String(colorUsage.color.jobCount), String(colorUsage.color.sheets)],
                  ["Black & white", String(colorUsage.bw.jobCount), String(colorUsage.bw.sheets)],
                ]}
              />
            </div>
            <ReportTable
              columns={["Mode", "Jobs", "Sheets"]}
              rows={[
                ["Color", colorUsage.color.jobCount.toLocaleString(), colorUsage.color.sheets.toLocaleString()],
                ["Black & white", colorUsage.bw.jobCount.toLocaleString(), colorUsage.bw.sheets.toLocaleString()],
              ]}
            />
          </div>
        </div>
      </details>
    </div>
  );
}

function ReportTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            {columns.map((c) => (
              <th key={c} className="py-2 pr-4">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--color-border)]">
              {row.map((cell, j) => (
                <td key={j} className="py-2 pr-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
