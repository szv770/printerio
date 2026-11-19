"use client";

import { useCallback, useMemo, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PeopleBrowser, type PeopleActions } from "./PeopleBrowser";
import { assignMemberCodeAction, assignMissingCodesAction, bulkUpdateMembersAction, listSectionsAction, loadPersonDetailAction } from "./bulk-actions";
import { peopleQueryToSearch, type PeoplePage, type PeopleQuery } from "@/lib/admin/people-query";

const ACTIONS: PeopleActions = {
  bulk: (input) => bulkUpdateMembersAction(input),
  loadDetail: (userId) => loadPersonDetailAction(userId),
  listSections: () => listSectionsAction(),
  assignCodes: () => assignMissingCodesAction(),
  assignCode: (userId) => assignMemberCodeAction(userId),
};

/** The real People list: the filters, sort and page live in the URL, so the server renders every page of results and
 *  back, forward and "copy link" all work. */
export function PeopleBrowserLive({ query, page, canEdit, missingCodes, notes }: { query: PeopleQuery; page: PeoplePage; canEdit: boolean; missingCodes: number; notes: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const onQueryChange = useCallback(
    (next: PeopleQuery) => {
      const search = peopleQueryToSearch(next);
      startTransition(() => router.push(search ? `${pathname}?${search}` : pathname, { scroll: false }));
    },
    [router, pathname],
  );
  const actions = useMemo(() => ACTIONS, []);
  return <PeopleBrowser query={query} page={page} canEdit={canEdit} onQueryChange={onQueryChange} loading={pending} actions={actions} missingCodes={missingCodes} notes={notes} />;
}
