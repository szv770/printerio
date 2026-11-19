"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PeopleBrowser, type PeopleActions } from "@/app/admin/users/PeopleBrowser";
import { GroupsPanel, type GroupsActions } from "@/app/admin/groups/GroupsPanel";
import { bulkAuditRow, bulkResultMessage, planBulkChange, type BulkOp, type BulkResult } from "@/lib/admin/bulk-members";
import { defaultPeopleQuery, runPeopleQuery, type PeopleQuery, type PersonRow } from "@/lib/admin/people-query";
import { distinctSections } from "@/lib/admin/people-list";
import { describeMemberAccess } from "@/lib/admin/member-access";
import { SAMPLE_ADMIN_ID, samplePeople } from "@/lib/admin/people-sample";
import type { GroupMemberRow, GroupSummary } from "@/lib/admin/groups-list";
import type { PersonDetail } from "@/lib/admin/person-detail";
import type { OrgRole } from "@printio/shared";

/** DEV-ONLY: the People list and Groups cards running over made-up people held in the browser. The same pure rules as the real
 *  page decide what a filter matches and what a bulk action may do; nothing here reaches auth or the database. */

const pause = (ms = 120) => new Promise((r) => setTimeout(r, ms));

export function PeopleBrowserPreview({ count, initialQuery }: { count: number; initialQuery?: Partial<PeopleQuery> }) {
  const [people, setPeople] = useState<PersonRow[]>(() => samplePeople(count));
  const [query, setQuery] = useState<PeopleQuery>(() => ({ ...defaultPeopleQuery(), ...initialQuery }));
  const [audit, setAudit] = useState<string[]>([]);
  const peopleRef = useRef(people);
  useEffect(() => {
    peopleRef.current = people;
  });

  const result = useMemo(() => runPeopleQuery(people, query), [people, query]);

  const actions: PeopleActions = useMemo(
    () => ({
      async bulk({ ids, op, confirmCount }): Promise<BulkResult> {
        await pause();
        if (confirmCount !== ids.length) return { ok: false, message: "The selection changed. Check the number and try again." };
        const all = peopleRef.current;
        const found = all.filter((p) => ids.includes(p.userId)).map((p) => ({ userId: p.userId, role: p.role, status: p.status, department: p.department }));
        const activeAdmins = all.filter((p) => p.role === "org_admin" && p.status === "active").length;
        const plan = planBulkChange({ actorId: SAMPLE_ADMIN_ID, op, requestedIds: ids, found, activeAdminCount: activeAdmins });
        if (!plan.ok) return { ok: false, message: plan.error, needsConfirm: plan.needsConfirm };
        const change = new Set(plan.changing);
        setPeople((prev) => applySample(prev, change, op));
        setAudit((a) => [JSON.stringify(bulkAuditRow({ organizationId: "sample-org", actorId: SAMPLE_ADMIN_ID, op, changedIds: plan.changing, unchanged: plan.unchanged }).metadata), ...a].slice(0, 5));
        return { ok: true, changed: plan.changing.length, message: bulkResultMessage(op, plan.changing.length, plan.unchanged) };
      },
      async loadDetail(userId): Promise<PersonDetail | null> {
        await pause(200);
        const p = peopleRef.current.find((x) => x.userId === userId);
        if (!p) return null;
        const groups = [{ id: "g1", name: "Science department" }, { id: "g3", name: "Grade 7" }].slice(0, 1 + (userId.length % 2));
        return {
          userId: p.userId,
          displayName: p.displayName,
          email: p.email,
          role: p.role,
          status: p.status,
          department: p.department,
          userCode: p.userCode,
          earlyTools: false,
          joinedAt: p.joinedAt,
          groups,
          access: describeMemberAccess({
            member: { userId: p.userId, role: p.role as OrgRole, department: p.department, groups },
            printers: [{ id: "pr1", name: "Main office Kyocera" }, { id: "pr2", name: "Library printer" }],
            rules: [],
            defaultAction: p.role === "student" ? "require_approval" : "allow",
            adminsBypassRestrictions: false,
          }),
          jobCount: 41,
          totalPages: 312,
        };
      },
      async listSections() {
        await pause(150);
        return distinctSections(peopleRef.current.map((p) => p.department));
      },
      async assignCodes() {
        await pause();
        const missing = peopleRef.current.filter((p) => !p.userCode).length;
        setPeople((prev) => prev.map((p) => (p.userCode ? p : { ...p, userCode: `N${p.userId.slice(1)}` })));
        return { ok: true, message: `Gave ${missing} ${missing === 1 ? "person" : "people"} a print code.`, remaining: 0 };
      },
      async assignCode(userId) {
        await pause();
        setPeople((prev) => prev.map((p) => (p.userId === userId ? { ...p, userCode: `N${userId.slice(1)}` } : p)));
        return { ok: true, message: "Print code assigned.", code: `N${userId.slice(1)}` };
      },
    }),
    [],
  );

  const missingCodes = people.filter((p) => !p.userCode).length;
  return (
    <>
      <PeopleBrowser
        query={query}
        page={{ rows: result.rows, total: result.total }}
        canEdit
        onQueryChange={useCallback((q: PeopleQuery) => setQuery(q), [])}
        actions={actions}
        missingCodes={missingCodes}
        readOnlyPreview
        initialSections={distinctSections(people.map((p) => p.department))}
      />
      {audit.length > 0 && (
        <p className="mt-6 text-xs text-[var(--color-muted)]" data-testid="preview-audit">
          Audit rows that would be written (one per bulk action): {audit[0]}
        </p>
      )}
    </>
  );
}

function applySample(prev: PersonRow[], ids: Set<string>, op: BulkOp): PersonRow[] {
  if (op.type === "remove") return prev.filter((p) => !ids.has(p.userId));
  return prev.map((p) => {
    if (!ids.has(p.userId)) return p;
    if (op.type === "role") return { ...p, role: op.role };
    if (op.type === "section") return { ...p, department: op.section };
    return { ...p, status: op.status };
  });
}

const GROUPS: Array<{ id: string; name: string; kind: string; has: (p: PersonRow, i: number) => boolean }> = [
  { id: "g1", name: "Science department", kind: "department", has: (p) => p.department === "Science" },
  { id: "g2", name: "Math department", kind: "department", has: (p) => p.department === "Math" },
  { id: "g3", name: "Grade 7", kind: "class", has: (_p, i) => i % 5 === 0 },
  { id: "g4", name: "Grade 8", kind: "class", has: (_p, i) => i % 7 === 1 },
  { id: "g5", name: "Grade 9", kind: "class", has: (_p, i) => i % 9 === 2 },
  { id: "g6", name: "Substitutes", kind: "custom", has: (_p, i) => i % 40 === 3 },
  { id: "g7", name: "Lab monitors", kind: "custom", has: (_p, i) => i % 31 === 4 },
  { id: "g8", name: "Yearbook club", kind: "custom", has: (_p, i) => i % 50 === 5 },
];

export function GroupsPanelPreview({ count }: { count: number }) {
  const people = useMemo(() => samplePeople(count), [count]);
  const [membership] = useState<Map<string, Set<string>>>(() => new Map(GROUPS.map((g) => [g.id, new Set(people.filter((p, i) => g.has(p, i)).map((p) => p.userId))])));
  const [version, setVersion] = useState(0);

  const groups: GroupSummary[] = useMemo(
    () => GROUPS.map((g) => ({ id: g.id, name: g.name, kind: g.kind, memberCount: membership.get(g.id)!.size })),
    // The count only follows the sample data when it is rebuilt (the card also moves its own count by one on add/remove).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, membership],
  );
  void version;

  const toRow = (p: PersonRow): GroupMemberRow => ({ userId: p.userId, name: p.displayName, email: p.email });
  const actions: GroupsActions = useMemo(
    () => ({
      async listMembers({ groupId, q, page }) {
        await pause(100);
        const ids = membership.get(groupId);
        if (!ids) return null;
        const needle = q.toLowerCase();
        const all = people.filter((p) => ids.has(p.userId) && (!needle || (p.displayName ?? "").toLowerCase().includes(needle) || p.email.includes(needle)));
        all.sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email));
        const size = 25;
        return { rows: all.slice((page - 1) * size, page * size).map(toRow), total: all.length, page, pageSize: size };
      },
      async searchCandidates({ groupId, q }) {
        await pause(100);
        const ids = membership.get(groupId)!;
        const needle = q.toLowerCase();
        return people
          .filter((p) => !ids.has(p.userId) && ((p.displayName ?? "").toLowerCase().includes(needle) || p.email.includes(needle)))
          .slice(0, 20)
          .map(toRow);
      },
      async addMember(groupId, userId) {
        membership.get(groupId)?.add(userId);
        setVersion((v) => v + 1);
        return {};
      },
      async removeMember(groupId, userId) {
        membership.get(groupId)?.delete(userId);
        setVersion((v) => v + 1);
        return {};
      },
    }),
    [people, membership],
  );
  return <GroupsPanel groups={groups} canManage actions={actions} readOnlyPreview />;
}
