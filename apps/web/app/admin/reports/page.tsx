import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Card, Badge, EmptyState } from "@/components/ui";
import { jobStatusDisplay } from "@/lib/job-status-labels";
import { currentPeriod } from "@/lib/quota";
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description={`Job activity over the last ${JOB_WINDOW_DAYS} days and usage over the last ${USAGE_MONTHS} months. "Sheets" only counts jobs that actually reached a printer (completed/printing/submitted_to_spooler) - denied and pending jobs never consumed paper. Tables only for V1 - see docs known-limitations.`}
      />

      <Card>
        <h2 className="mb-3 font-medium">Pages by month</h2>
        {pagesByMonth.length === 0 ? (
          <EmptyState message="No usage recorded yet." />
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
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">Color usage ({JOB_WINDOW_DAYS}d)</h2>
        <ReportTable
          columns={["Mode", "Jobs", "Sheets"]}
          rows={[
            ["Color", colorUsage.color.jobCount.toLocaleString(), colorUsage.color.sheets.toLocaleString()],
            ["Black & white", colorUsage.bw.jobCount.toLocaleString(), colorUsage.bw.sheets.toLocaleString()],
          ]}
        />
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-medium">By user ({JOB_WINDOW_DAYS}d)</h2>
          {byUser.length === 0 ? (
            <EmptyState message="No jobs in this window." />
          ) : (
            <ReportTable
              columns={["User", "Jobs", "Sheets"]}
              rows={byUser.map((r) => [r.label, r.jobCount.toLocaleString(), r.sheets.toLocaleString()])}
            />
          )}
        </Card>

        <Card>
          <h2 className="mb-3 font-medium">By department ({JOB_WINDOW_DAYS}d)</h2>
          {byDepartment.length === 0 ? (
            <EmptyState message="No department-tagged jobs in this window." />
          ) : (
            <ReportTable
              columns={["Department", "Jobs", "Sheets"]}
              rows={byDepartment.map((r) => [r.label, r.jobCount.toLocaleString(), r.sheets.toLocaleString()])}
            />
          )}
        </Card>

        <Card>
          <h2 className="mb-3 font-medium">By printer ({JOB_WINDOW_DAYS}d)</h2>
          {byPrinter.length === 0 ? (
            <EmptyState message="No jobs in this window." />
          ) : (
            <ReportTable
              columns={["Printer", "Jobs", "Sheets"]}
              rows={byPrinter.map((r) => [r.label, r.jobCount.toLocaleString(), r.sheets.toLocaleString()])}
            />
          )}
        </Card>

        <Card>
          <h2 className="mb-3 font-medium">Recently denied / failed</h2>
          {rejectedFailed.length === 0 ? (
            <EmptyState message="No denied or failed jobs in this window." />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {rejectedFailed.map((j) => {
                const display = jobStatusDisplay(j.status);
                return (
                  <li key={j.id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
                    <span>{labelByUser.get(j.createdBy) ?? j.createdBy}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={j.status === "denied" ? "danger" : "warning"}>
                        {display.emoji} {display.label}
                      </Badge>
                      <span className="text-[var(--color-muted)]">{new Date(j.createdAt).toLocaleDateString()}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
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
