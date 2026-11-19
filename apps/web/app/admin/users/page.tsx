import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/session";
import { PageHeader, Tabs } from "@/components/ui";
import { peopleTabs } from "@/lib/admin/tabs";
import { PeopleBrowserLive } from "./PeopleBrowserLive";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { logger } from "@/lib/logger";
import { findUnmatchedSignups, type UnmatchedSignup } from "@/lib/admin/unmatched-signups";
import { UnmatchedSignups } from "./UnmatchedSignups";
import { countMembersWithoutCode, fetchPeoplePage } from "@/lib/admin/people-list";
import { pageCount, parsePeopleParams, peopleQueryToSearch } from "@/lib/admin/people-query";
import { routes } from "@/lib/routes";

/** The People list. The filter, sort and page come from the URL (never trusted: parsePeopleParams cleans them); the
 *  organization comes from the signed-in admin's session; the database sends one page and the exact match count. */
export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireOrgRole(["org_admin", "approver"]);
  const supabase = await createClient();
  const orgId = session.membership.organization_id;
  const isOrgAdmin = session.membership.role === "org_admin";
  const query = parsePeopleParams(await searchParams);

  const result = await fetchPeoplePage(supabase, orgId, query);
  if (result.outOfRange) {
    // Someone kept an old link to a page that no longer exists (people were removed): show the last page instead.
    const last = Math.max(1, pageCount(result.total, query.pageSize));
    const search = peopleQueryToSearch({ ...query, page: last });
    redirect(search ? `${routes.adminUsers}?${search}` : routes.adminUsers);
  }

  // Admin-only extras. Print codes are NOT written here any more (they used to be, on every page view): a person gets
  // theirs when they first print, or when an admin presses "Give print codes now".
  let signups: UnmatchedSignup[] = [];
  let missingCodes = 0;
  if (isOrgAdmin) {
    try {
      signups = await findUnmatchedSignups(createServiceRoleClient());
    } catch (err) {
      logger.error("could not list sign-ups without access", { error: err instanceof Error ? err.message : String(err) });
    }
    missingCodes = await countMembersWithoutCode(supabase, orgId).catch(() => 0);
  }

  const notes: string[] = [];
  if (result.searchTruncated) notes.push("Lots of names match that. Type more of the name or email to narrow it down.");
  if (result.sortFellBack) notes.push("Sorting by name is not available right now, so people are shown by date joined.");

  return (
    <div>
      <PageHeader title="Users" description="Everyone who can print here. Open a person to change their role, section or print code, or tick several to change them together." />
      <Tabs label="People" items={peopleTabs("users", isOrgAdmin)} />
      <PeopleBrowserLive query={query} page={{ rows: result.rows, total: result.total }} canEdit={isOrgAdmin} missingCodes={missingCodes} notes={notes} />
      {isOrgAdmin && <UnmatchedSignups signups={signups} />}
    </div>
  );
}
