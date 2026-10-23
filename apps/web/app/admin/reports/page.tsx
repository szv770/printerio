import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { currentPeriod } from "@/lib/quota";
import { REPORT_ROW_LIMIT, parseReportRange, rangeSinceIso, truncationNote } from "@/lib/admin/reports-view";
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
import { ReportsView } from "./ReportsView";

const USAGE_MONTHS = 6;

function monthsAgoPeriod(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  const range = parseReportRange((await searchParams).range);

  // Server Component snapshot at request time, not a value React needs to
  // keep referentially stable across re-renders - same rationale as
  // admin/page.tsx's onlineCutoff.
  const since = rangeSinceIso(range, new Date());
  const oldestPeriod = monthsAgoPeriod(USAGE_MONTHS - 1);

  const [{ data: jobRows }, { data: members }, { data: printerRows }, { data: usageRows }] = await Promise.all([
    supabase
      .from("print_jobs")
      .select(
        "id, created_by, color_mode, status, printer_id, estimated_physical_sheets, source_pdf_pages, copies, created_at",
      )
      .eq("organization_id", orgId)
      // Admin test prints are real jobs on a real queue, but they are not
      // anyone's print activity - counting them here would inflate the
      // sending admin's own row, their department, and that printer's totals
      // with paper nobody requested (supabase/migrations/0024_*.sql).
      .eq("is_test_print", false)
      .gte("created_at", since)
      // Newest first with an explicit cap: the database would otherwise cut
      // the list at 1,000 rows without saying so, and not necessarily the oldest.
      .order("created_at", { ascending: false })
      .limit(REPORT_ROW_LIMIT),
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

  const byUser = aggregateByUser(jobs, (id) => labelByUser.get(id) ?? "Unknown user");
  const byDepartment = aggregateByDepartment(jobs);
  const byPrinter = aggregateByPrinter(jobs, (id) => nameByPrinter.get(id) ?? "Unknown printer");
  const colorUsage = aggregateColorUsage(jobs);
  const problems = recentRejectedOrFailed(jobs);
  const totalSheets = colorUsage.color.sheets + colorUsage.bw.sheets;

  return (
    <ReportsView
      range={range}
      isOrgAdmin={session.membership.role === "org_admin"}
      stats={{
        sheets: totalSheets,
        jobs: jobs.length,
        colorPct: totalSheets > 0 ? Math.round((colorUsage.color.sheets / totalSheets) * 100) : null,
        problems: jobs.filter((j) => j.status === "denied" || j.status === "failed").length,
      }}
      truncated={truncationNote(jobs.length, REPORT_ROW_LIMIT)}
      byUser={byUser}
      byDepartment={byDepartment}
      byPrinter={byPrinter}
      problems={problems.map((j) => ({
        id: j.id,
        who: labelByUser.get(j.createdBy) ?? "Unknown user",
        status: j.status,
        createdAt: j.createdAt,
      }))}
      months={aggregatePagesByMonth(usage)}
      thisPeriod={currentPeriod()}
      color={{
        colorJobs: colorUsage.color.jobCount,
        colorSheets: colorUsage.color.sheets,
        bwJobs: colorUsage.bw.jobCount,
        bwSheets: colorUsage.bw.sheets,
      }}
    />
  );
}
