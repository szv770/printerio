import { AdminFrame } from "@/components/shell/AdminFrame";
import { PageHeader, Tabs } from "@/components/ui";
import type { Tables } from "@/lib/database.types";
import { rulesTabs } from "@/lib/admin/tabs";
import { PoliciesPanel } from "@/app/admin/policies/PoliciesPanel";
import { QuotasPanel } from "@/app/admin/quotas/QuotasPanel";
import { ReportsView } from "@/app/admin/reports/ReportsView";
import { AuditView } from "@/app/admin/audit/AuditView";
import { ApprovalList } from "@/app/admin/approvals/ApprovalList";
import { StoragePanel } from "@/app/admin/storage/StoragePanel";
import { JobsView, type JobListRow } from "@/app/admin/jobs/JobsView";
import { parseJobsQuery } from "@/lib/admin/all-jobs";

/** DEV-ONLY sample data for admin group B (rules, limits, reports, approvals, files, all jobs). Nothing here touches auth or the database. */

const USER = { name: "Dana Kaplan", email: "dana@lecfl.com", roleLabel: "Admin" };
const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

function Frame({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <AdminFrame isOrgAdmin isSuperAdmin={false} userId="preview-user" pendingApprovals={2} user={USER} pathnameOverride={path}>
      {children}
    </AdminFrame>
  );
}

const POLICIES = [
  { id: "pol1", name: "Everyone", organization_id: "o", created_at: ago(9000) },
  { id: "pol2", name: "Staff rules", organization_id: "o", created_at: ago(8000) },
] as unknown as Tables<"print_policies">[];

const RULES = [
  { id: "r1", policy_id: "pol1", action: "require_approval", enabled: true, priority: 100, reason_label: "x", conditions: [{ field: "colorMode", operator: "eq", value: "color" }, { field: "pageCount", operator: "gt", value: 20 }] },
  { id: "r2", policy_id: "pol1", action: "require_approval", enabled: true, priority: 100, reason_label: "x", conditions: [{ field: "copies", operator: "gt", value: 30 }] },
  { id: "r3", policy_id: "pol1", action: "deny", enabled: false, priority: 100, reason_label: "x", conditions: [{ field: "dayOfWeek", operator: "in", value: [0, 6] }, { field: "role", operator: "eq", value: "student" }] },
  { id: "r4", policy_id: "pol2", action: "allow", enabled: true, priority: 100, reason_label: "x", conditions: [{ field: "groupIds", operator: "contains", value: "g1" }, { field: "paperSize", operator: "eq", value: "11x17" }] },
] as unknown as Tables<"policy_rules">[];

export function RulesPreview({ variant }: { variant?: string }) {
  return (
    <Frame path="/admin/policies">
      <PageHeader title="Print rules" description="Say when a job needs approval or is not allowed. Switch a rule off to pause it." />
      <Tabs label="Rules and limits" items={rulesTabs("rules")} />
      <PoliciesPanel
        policies={variant === "empty" ? [] : POLICIES}
        rules={variant === "empty" ? [] : RULES}
        canManage
        groupNames={{ g1: "Science" }}
      />
    </Frame>
  );
}

const QUOTAS = [
  { id: "q1", organization_id: "o", scope_type: "organization", scope_value: null, period: "monthly", limit_value: 500 },
  { id: "q2", organization_id: "o", scope_type: "role", scope_value: "student", period: "monthly", limit_value: 150 },
  { id: "q3", organization_id: "o", scope_type: "group", scope_value: "g1", period: "monthly", limit_value: 1200 },
] as unknown as Tables<"quotas">[];

export function LimitsPreview({ variant }: { variant?: string }) {
  return (
    <Frame path="/admin/quotas">
      <PageHeader title="Monthly limits" description="How many sheets someone can print each month. If a person fits more than one limit, the lowest one applies." />
      <Tabs label="Rules and limits" items={rulesTabs("quotas")} />
      <QuotasPanel
        quotas={variant === "empty" ? [] : QUOTAS}
        groups={[{ id: "g1", name: "Science department" }]}
        roster={[{ userId: "u1", label: "Dana Kaplan" }]}
        canManage
      />
    </Frame>
  );
}

const ROWS = (label: string[]) => label.map((l, i) => ({ key: `${i}`, label: l, jobCount: 120 - i * 17, sheets: 410 - i * 60 }));

export function ReportsPreview({ variant }: { variant?: string }) {
  return (
    <Frame path="/admin/reports">
      <ReportsView
        range={30}
        isOrgAdmin
        stats={{ sheets: 2840, jobs: 612, colorPct: 18, problems: 3 }}
        truncated={variant === "truncated" ? "Showing the first 1,000 rows" : null}
        byUser={ROWS(["Moshe Levi", "Rivka Stein", "Avi Goldman", "Dana Kaplan"])}
        byDepartment={ROWS(["Math", "Science", "Art"])}
        byPrinter={ROWS(["Main office Kyocera", "Library printer"])}
        problems={[
          { id: "p1", who: "Moshe Levi", status: "failed", createdAt: ago(300) },
          { id: "p2", who: "Avi Goldman", status: "denied", createdAt: ago(2000) },
          { id: "p3", who: "Rivka Stein", status: "failed", createdAt: ago(5000) },
        ]}
        months={[
          { period: "2026-09", pdfPages: 5400, printedSides: 5100, physicalSheets: 3100, colorWeighted: 5900 },
          { period: "2026-10", pdfPages: 4800, printedSides: 4500, physicalSheets: 2840, colorWeighted: 5200 },
        ]}
        thisPeriod="2026-10"
        color={{ colorJobs: 90, colorSheets: 510, bwJobs: 522, bwSheets: 2330 }}
      />
    </Frame>
  );
}

export function ActivityPreview({ variant }: { variant?: string }) {
  const rows =
    variant === "empty"
      ? []
      : [
          { id: "a1", createdAt: ago(12), who: "Dana Kaplan", action: "member.role_changed", details: [{ label: "Role", value: "Approver" }, { label: "Target", value: "rivka@lecfl.com" }] },
          { id: "a2", createdAt: ago(90), who: "Dana Kaplan", action: "storage.cleanup_run", details: [{ label: "Files deleted", value: "14" }, { label: "Jobs purged", value: "9" }] },
          { id: "a3", createdAt: ago(1200), who: "The system", action: "agent.registered", details: [] },
          { id: "a4", createdAt: ago(3000), who: "Rivka Stein", action: "invitation.redeemed", details: [{ label: "Role", value: "User" }] },
        ];
  return (
    <Frame path="/admin/audit">
      <AuditView rows={rows} truncated={variant === "truncated" ? "Showing the latest 200 rows" : null} />
    </Frame>
  );
}

function job(over: Record<string, unknown>) {
  return {
    id: "j1",
    job_number: "PJ-1042",
    original_file_name: "Unit 4 quiz.pdf",
    created_by: "u2",
    created_at: ago(7),
    source_pdf_pages: 12,
    copies: 2,
    color_mode: "color",
    duplex: true,
    paper_size: "Letter",
    estimated_physical_sheets: 12,
    file_size_bytes: 1_840_000,
    finishing: { staple: true },
    policy_reasons: ["Color jobs over 10 pages need approval"],
    printer_profile_id: "pp1",
    ...over,
  } as unknown as Tables<"print_jobs">;
}

export function ApprovalsPreview({ variant }: { variant?: string }) {
  const jobs =
    variant === "empty"
      ? []
      : [
          job({}),
          job({ id: "j2", job_number: "PJ-1043", original_file_name: "Science fair poster with a very long file name final v3.pdf", created_by: "u3", created_at: ago(65), source_pdf_pages: 1, copies: 1, color_mode: "bw", duplex: false, paper_size: "11x17", estimated_physical_sheets: 1, finishing: {}, policy_reasons: ["Jobs on 11x17 paper need approval"] }),
        ];
  return (
    <Frame path="/admin/approvals">
      <PageHeader title="Approvals" description={jobs.length ? "Say yes or no to each job." : "Jobs that need a yes or no show up here."} />
      <ApprovalList jobs={jobs} submitterNames={{ u2: "Moshe Levi", u3: "Rivka Stein" }} printerLabels={{ pp1: "Main office Kyocera" }} />
    </Frame>
  );
}

export function FilesPreview({ variant }: { variant?: string }) {
  const empty = { jobs: 0, bytes: 0 };
  const summary =
    variant === "clean"
      ? { total: { jobs: 5, bytes: 9_000_000 }, active: { jobs: 2, bytes: 3_000_000 }, withinRetention: { jobs: 3, bytes: 6_000_000 }, cleanable: empty, cleanableByGroup: { completed: empty, rejected: empty, failed: empty } }
      : {
          total: { jobs: 41, bytes: 126_000_000 },
          active: { jobs: 4, bytes: 9_000_000 },
          withinRetention: { jobs: 27, bytes: 71_000_000 },
          cleanable: { jobs: 10, bytes: 46_000_000 },
          cleanableByGroup: { completed: { jobs: 7, bytes: 33_000_000 }, rejected: { jobs: 2, bytes: 8_000_000 }, failed: { jobs: 1, bytes: 5_000_000 } },
        };
  return (
    <Frame path="/admin/storage">
      <PageHeader title="Files & storage" description="Files people send to print are kept for a short time, then removed. Job history stays." />
      <StoragePanel
        summary={summary}
        windows={[
          { group: "completed", days: 7 },
          { group: "rejected", days: 3 },
          { group: "failed", days: 7 },
        ]}
        truncated={false}
      />
    </Frame>
  );
}

const NAMES = ["Moshe Levi", "Rivka Stein", "Avi Goldman", "Dana Kaplan"];
const STATUSES = ["completed", "printing", "failed", "pending_approval", "held", "completed", "cancelled", "approved"];
const FILES = ["Unit 4 quiz.pdf", "Science fair poster.pdf", "Permission slip.pdf", "Budget 2026.pdf", "Field trip forms.pdf", "Weekly newsletter with a long name.pdf"];

export function AllJobsPreview({ variant }: { variant?: string }) {
  const query = parseJobsQuery(variant === "failed" ? { status: "failed" } : variant === "search" ? { q: "moshe" } : variant === "page2" ? { page: "2" } : {});
  const rows: JobListRow[] =
    variant === "empty"
      ? []
      : Array.from({ length: variant === "failed" ? 3 : 8 }, (_, i) => ({
          id: `j${i}`,
          jobNumber: `PJ-${1050 - i}`,
          fileName: FILES[i % FILES.length]!,
          who: NAMES[i % NAMES.length]!,
          status: variant === "failed" ? "failed" : STATUSES[i % STATUSES.length]!,
          pages: 3 + i * 4,
          copies: i % 3 === 0 ? 2 : 1,
          createdAt: ago(10 + i * 95),
          isTest: i === 5,
        }));
  return (
    <Frame path="/admin/jobs">
      <JobsView rows={rows} query={variant === "empty" ? { ...query, q: "zzz" } : query} hasOlder={variant !== "failed"} />
    </Frame>
  );
}
