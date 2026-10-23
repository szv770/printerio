import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { pageRange, parseJobsQuery, sanitizeSearch, statusesForFilter, trimPage } from "@/lib/admin/all-jobs";
import { JobsView } from "./JobsView";

/** Most people a name search can match (the job filter stays bounded). */
const SEARCH_USER_CAP = 50;

type Params = { status?: string | string[]; q?: string | string[]; page?: string | string[] };

/**
 * Admin and approver view of every job in the organization. Read with the
 * session client (RLS lets approvers and admins read their own organization's
 * jobs and profiles), filtered by organization, 25 per page, newest first.
 */
export default async function AllJobsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  const query = parseJobsQuery(await searchParams);
  const search = sanitizeSearch(query.q);

  let request = supabase
    .from("print_jobs")
    .select("id, job_number, original_file_name, status, created_by, created_at, source_pdf_pages, copies, is_test_print")
    .eq("organization_id", orgId);

  const statuses = statusesForFilter(query.status);
  if (statuses) request = request.in("status", statuses);

  if (search) {
    // "By user" means matching a person's name or email, then their jobs.
    const [{ data: people }, { data: members }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id")
        .or(`display_name.ilike.%${search}%,email.ilike.%${search}%`)
        .limit(SEARCH_USER_CAP),
      supabase.from("organization_members").select("user_id").eq("organization_id", orgId),
    ]);
    const inOrg = new Set((members ?? []).map((m) => m.user_id));
    const ids = (people ?? []).map((p) => p.id).filter((id) => inOrg.has(id));
    request = request.or(
      ids.length > 0 ? `original_file_name.ilike.%${search}%,created_by.in.(${ids.join(",")})` : `original_file_name.ilike.%${search}%`,
    );
  }

  const { from, to } = pageRange(query.page);
  const { data: jobs } = await request.order("created_at", { ascending: false }).range(from, to);
  const { rows, hasOlder } = trimPage(jobs ?? []);

  const submitterIds = [...new Set(rows.map((j) => j.created_by))];
  const { data: submitters } =
    submitterIds.length > 0
      ? await supabase.from("profiles").select("id, display_name, email").in("id", submitterIds)
      : { data: [] as { id: string; display_name: string | null; email: string }[] };
  const nameById = new Map((submitters ?? []).map((p) => [p.id, p.display_name?.trim() || p.email]));

  return (
    <JobsView
      query={query}
      hasOlder={hasOlder}
      rows={rows.map((j) => ({
        id: j.id,
        jobNumber: j.job_number,
        fileName: j.original_file_name,
        who: nameById.get(j.created_by) ?? "Unknown user",
        status: j.status,
        pages: j.source_pdf_pages,
        copies: j.copies,
        createdAt: j.created_at,
        isTest: j.is_test_print,
      }))}
    />
  );
}
