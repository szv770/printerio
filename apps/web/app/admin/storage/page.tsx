import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { routes } from "@/lib/routes";
import { summarizeStorageUsage } from "@/lib/storage-usage";
import { retentionWindows } from "@/lib/retention";
import { StoragePanel } from "./StoragePanel";

/** How many job rows the summary reads. Only jobs whose files still exist
 *  (`files_purged_at is null`) are selected, and retention keeps that set
 *  small - a few days' worth - so this is generous headroom, not a real
 *  constraint. If it is ever hit, the page says the figures are a floor
 *  rather than quietly under-reporting. */
const SUMMARY_ROW_LIMIT = 5000;

export default async function AdminStoragePage() {
  const session = await requireOrgRole(["org_admin", "approver"]);
  // Cleaning up files is an org_admin action, and so is seeing the whole
  // organization's storage picture - approvers get the approval queue, not
  // this. (The nav link is hidden for them too; this is the real gate.)
  if (session.membership.role !== "org_admin") redirect(routes.admin);

  const organizationId = session.membership.organization_id;
  const supabase = await createClient();

  const [{ data: settings }, { data: jobs, count }] = await Promise.all([
    supabase
      .from("organization_settings")
      .select("retention_completed_days, retention_rejected_days, retention_failed_days")
      .eq("organization_id", organizationId)
      .single(),
    // Only three small columns, and only for jobs that still hold files -
    // there is no aggregate available through PostgREST without a database
    // function, and at this scale (a school, files kept for days) reading the
    // live set and summing it in one pass is cheaper than adding one.
    supabase
      .from("print_jobs")
      .select("status, file_size_bytes, updated_at", { count: "exact" })
      .eq("organization_id", organizationId)
      .is("files_purged_at", null)
      .not("original_file_path", "is", null)
      .order("updated_at", { ascending: false })
      .limit(SUMMARY_ROW_LIMIT),
  ]);

  const retention = {
    retention_completed_days: settings?.retention_completed_days ?? 7,
    retention_rejected_days: settings?.retention_rejected_days ?? 3,
    retention_failed_days: settings?.retention_failed_days ?? 7,
  };

  // A Server Component computing a fresh snapshot per request - the "now"
  // the retention cutoffs are measured against, same idea as
  // app/admin/page.tsx's own online/offline cutoff.
  const summary = summarizeStorageUsage(jobs ?? [], retention, new Date());

  return (
    <div>
      <PageHeader title="Storage" />
      <StoragePanel
        summary={summary}
        windows={retentionWindows(retention).map((w) => ({ group: w.group, days: w.days }))}
        truncated={(count ?? 0) > (jobs?.length ?? 0)}
      />
    </div>
  );
}
