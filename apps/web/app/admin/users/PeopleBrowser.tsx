"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, Users, X } from "lucide-react";
import { Badge, Button, EmptyState, Input, Modal, Select } from "@/components/ui";
import { roleLabel } from "@/lib/role-label";
import { roleChoices } from "@/lib/admin/members";
import {
  NO_SECTION,
  PEOPLE_PAGE_SIZES,
  PEOPLE_SORTS,
  activeFilterCount,
  hasActiveFilter,
  pageCount,
  type PeopleFilter,
  type PeopleQuery,
  type PeoplePage,
  type PeopleSort,
  type PersonRow,
} from "@/lib/admin/people-query";
import type { BulkOp, BulkResult } from "@/lib/admin/bulk-members";
import type { PersonDetail } from "@/lib/admin/person-detail";
import { BulkDialog, type BulkMode } from "./BulkDialog";
import { PersonDrawer, initials } from "./PersonDrawer";

/** Everything the list needs from the server. The real page passes the server actions; the dev preview passes in-memory stand-ins. */
export interface PeopleActions {
  bulk: (input: { ids: string[]; op: BulkOp; confirmCount: number }) => Promise<BulkResult>;
  loadDetail: (userId: string) => Promise<PersonDetail | null>;
  listSections: () => Promise<string[]>;
  assignCodes: () => Promise<{ ok: boolean; message: string; remaining?: number }>;
  assignCode: (userId: string) => Promise<{ ok: boolean; message: string; code?: string }>;
}

export interface PeopleBrowserProps {
  query: PeopleQuery;
  page: PeoplePage;
  canEdit: boolean;
  /** Called with the new query; the page turns it into a URL (real) or re-runs it over sample data (preview). */
  onQueryChange: (next: PeopleQuery) => void;
  loading?: boolean;
  actions: PeopleActions;
  /** People with no print code yet (admins see a button to give them out). */
  missingCodes?: number;
  /** Notes from the server: a search that matched too many names, or a sort that fell back. */
  notes?: string[];
  readOnlyPreview?: boolean;
  /** Dev preview: sections are known up front. */
  initialSections?: string[] | null;
}

const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;

export function PeopleBrowser({ query, page, canEdit, onQueryChange, loading = false, actions, missingCodes = 0, notes = [], readOnlyPreview = false, initialSections = null }: PeopleBrowserProps) {
  const { rows, total } = page;
  const pages = pageCount(total, query.pageSize);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<BulkMode | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [sections, setSections] = useState<string[] | null>(initialSections);
  const [sheet, setSheet] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const sectionsRequested = useRef(initialSections !== null);

  const queryKey = JSON.stringify([query.filter, query.sort, query.dir, query.page, query.pageSize]);

  // A new page or filter starts with nothing ticked (a tick on a row you can no longer see is how mistakes happen).
  const [selectionFor, setSelectionFor] = useState(queryKey);
  if (selectionFor !== queryKey) {
    setSelectionFor(queryKey);
    setSelected(new Set());
  }

  const loadSections = useCallback(() => {
    if (sectionsRequested.current) return;
    sectionsRequested.current = true;
    actions
      .listSections()
      .then(setSections)
      .catch(() => {
        sectionsRequested.current = false;
        setSections([]);
      });
  }, [actions]);

  const setFilter = (patch: Partial<PeopleFilter>) => onQueryChange({ ...query, filter: { ...query.filter, ...patch }, page: 1 });
  const go = (p: number) => onQueryChange({ ...query, page: Math.min(Math.max(1, p), pages) });

  const visibleIds = useMemo(() => rows.map((r) => r.userId), [rows]);
  const allTicked = rows.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openRow = rows.find((r) => r.userId === openId) ?? null;
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const filtering = hasActiveFilter(query.filter);

  async function runBulk(op: BulkOp): Promise<BulkResult> {
    const res = await actions.bulk({ ids: selectedIds, op, confirmCount: selectedIds.length });
    if (res.ok) {
      setMode(null);
      setSelected(new Set());
      setNotice({ tone: "ok", text: res.message });
    }
    return res;
  }

  async function giveCodes() {
    setCodeBusy(true);
    try {
      const res = await actions.assignCodes();
      setNotice({ tone: res.ok ? "ok" : "bad", text: res.message });
    } catch {
      setNotice({ tone: "bad", text: "Could not give out print codes right now." });
    }
    setCodeBusy(false);
  }

  const filterControls = (
    <FilterControls
      query={query}
      sections={sections}
      onFilter={setFilter}
      onSort={(sort, dir) => onQueryChange({ ...query, sort, dir, page: 1 })}
    />
  );

  return (
    <div className={selectedIds.length > 0 ? "pb-44 md:pb-28" : ""}>
      <div className="mb-3 flex gap-2" onPointerEnter={loadSections} onFocusCapture={loadSections}>
        <SearchBox value={query.filter.q} onChange={(q) => setFilter({ q })} />
        <Button type="button" variant="outline" className="md:hidden" onClick={() => { loadSections(); setSheet(true); }} aria-label="Filters">
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          Filters{activeFilterCount({ ...query.filter, q: "" }) > 0 ? ` (${activeFilterCount({ ...query.filter, q: "" })})` : ""}
        </Button>
      </div>
      <div className="mb-3 hidden gap-3 md:grid md:grid-cols-[repeat(4,minmax(0,1fr))]" onPointerEnter={loadSections} onFocusCapture={loadSections}>
        {filterControls}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--color-muted)]" aria-live="polite">
        <span>
          {filtering ? `${people(total)} match` : people(total)}
          {total > 0 && ` · showing ${((query.page - 1) * query.pageSize + 1).toLocaleString("en-US")}-${Math.min(total, query.page * query.pageSize).toLocaleString("en-US")}`}
        </span>
        {filtering && (
          <button type="button" className="min-h-8 text-[var(--color-primary)] hover:underline" onClick={() => onQueryChange({ ...query, filter: { q: "", role: null, status: null, section: null }, page: 1 })}>
            Clear filters
          </button>
        )}
      </div>

      {notes.map((n) => (
        <p key={n} className="mb-3 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-3 py-2 text-[13px] text-[var(--color-text-2)]">
          {n}
        </p>
      ))}
      {notice && (
        <p
          role="status"
          className={`mb-3 flex items-start justify-between gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm ${
            notice.tone === "ok" ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </p>
      )}
      {canEdit && missingCodes > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[var(--color-text-2)]">
            <strong className="font-semibold text-[var(--color-text)]">{people(missingCodes)}</strong> {missingCodes === 1 ? "has" : "have"} no print code yet. A code is made the first time someone prints.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void giveCodes()} pending={codeBusy} pendingLabel="Working...">
            Give print codes now
          </Button>
        </div>
      )}

      <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
        {rows.length === 0 ? (
          filtering ? (
            <EmptyState message="Nobody matches that search or filter." icon={Search} />
          ) : (
            <EmptyState message="No users yet. Invite someone to get started." icon={Users} />
          )
        ) : (
          <PeopleRows rows={rows} selected={selected} canEdit={canEdit} allTicked={allTicked} onToggle={toggle} onToggleAll={() => setSelected(allTicked ? new Set() : new Set(visibleIds))} onOpen={setOpenId} />
        )}
      </div>

      {total > 0 && (
        <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => go(query.page - 1)} disabled={query.page <= 1} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Prev
            </Button>
            <span className="px-3 text-[var(--color-muted)]">
              Page {query.page.toLocaleString("en-US")} of {pages.toLocaleString("en-US")}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => go(query.page + 1)} disabled={query.page >= pages} aria-label="Next page">
              Next
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <label className="flex items-center gap-2 whitespace-nowrap text-[var(--color-muted)]">
            Rows per page
            <Select value={query.pageSize} onChange={(e) => onQueryChange({ ...query, pageSize: Number(e.target.value), page: 1 })} className="w-20">
              {PEOPLE_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        </nav>
      )}

      {canEdit && selectedIds.length > 0 && (
        <BulkBar count={selectedIds.length} pageCount={rows.length} onPick={(m) => { loadSections(); setMode(m); }} onClear={() => setSelected(new Set())} />
      )}
      <BulkDialog key={mode ?? "none"} mode={mode} count={selectedIds.length} sections={sections} onClose={() => setMode(null)} onRun={runBulk} />

      {openRow && (
        <PersonDrawer
          key={openRow.userId}
          row={openRow}
          canEdit={canEdit}
          loadDetail={actions.loadDetail}
          assignCode={actions.assignCode}
          onClose={() => setOpenId(null)}
          readOnlyPreview={readOnlyPreview}
        />
      )}

      <Modal
        open={sheet}
        onClose={() => setSheet(false)}
        title="Filters"
        description={`${people(total)} match right now`}
        footer={
          <Button onClick={() => setSheet(false)} className="w-full">
            Show {people(total)}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">{filterControls}</div>
      </Modal>
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [text, setText] = useState(value);
  const pushed = useRef(value);
  // An outside change (Clear filters) replaces the text; the admin's own typing never does.
  useEffect(() => {
    if (value !== pushed.current) {
      pushed.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text.trim() === pushed.current.trim()) return;
    const t = setTimeout(() => {
      pushed.current = text.trim();
      onChange(text.trim());
    }, 350);
    return () => clearTimeout(t);
  }, [text, onChange]);
  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">Search people</span>
      <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[var(--color-faint)]" aria-hidden="true" />
      <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search people" className="pl-10" maxLength={100} />
    </label>
  );
}

function FilterControls({
  query,
  sections,
  onFilter,
  onSort,
}: {
  query: PeopleQuery;
  sections: string[] | null;
  onFilter: (patch: Partial<PeopleFilter>) => void;
  onSort: (sort: PeopleSort, dir: "asc" | "desc") => void;
}) {
  const f = query.filter;
  // The chosen section is always an option, even before the full list has loaded.
  const sectionOptions = useMemo(() => {
    const list = sections ?? [];
    return f.section && f.section !== NO_SECTION && !list.includes(f.section) ? [f.section, ...list] : list;
  }, [sections, f.section]);
  return (
    <>
      <Select value={f.role ?? ""} onChange={(e) => onFilter({ role: e.target.value || null })} aria-label="Role">
        <option value="">All roles</option>
        {roleChoices().map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </Select>
      <Select value={f.section ?? ""} onChange={(e) => onFilter({ section: e.target.value || null })} aria-label="Section">
        <option value="">All sections</option>
        <option value={NO_SECTION}>No section</option>
        {sectionOptions.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        {sections === null && <option disabled>Loading...</option>}
      </Select>
      <Select value={f.status ?? ""} onChange={(e) => onFilter({ status: (e.target.value || null) as PeopleFilter["status"] })} aria-label="Status">
        <option value="">Active and off</option>
        <option value="active">Active</option>
        <option value="disabled">Off</option>
      </Select>
      <Select
        value={`${query.sort}:${query.dir}`}
        onChange={(e) => {
          const [s, d] = e.target.value.split(":");
          onSort(s as PeopleSort, d === "desc" ? "desc" : "asc");
        }}
        aria-label="Sort by"
      >
        {PEOPLE_SORTS.flatMap((s) => [
          <option key={`${s.value}:asc`} value={`${s.value}:asc`}>
            {s.label} ({s.value === "joined" ? "oldest first" : "A to Z"})
          </option>,
          <option key={`${s.value}:desc`} value={`${s.value}:desc`}>
            {s.label} ({s.value === "joined" ? "newest first" : "Z to A"})
          </option>,
        ])}
      </Select>
    </>
  );
}

function PeopleRows({
  rows,
  selected,
  canEdit,
  allTicked,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  rows: PersonRow[];
  selected: Set<string>;
  canEdit: boolean;
  allTicked: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onOpen: (id: string) => void;
}) {
  const box = "h-5 w-5 shrink-0 cursor-pointer rounded-[var(--radius-chip)] accent-[var(--color-primary)]";
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">People</caption>
          <thead>
            <tr className="text-left text-xs font-semibold tracking-wide text-[var(--color-muted)]">
              {canEdit && (
                <th scope="col" className="w-12 border-b border-[var(--color-border)] bg-[var(--color-thead)] py-2.5 pl-5">
                  <input type="checkbox" className={box} checked={allTicked} onChange={onToggleAll} aria-label="Select everyone on this page" />
                </th>
              )}
              {["Name", "Section", "Role", "Print code", "Status"].map((h) => (
                <th key={h} scope="col" className="border-b border-[var(--color-border)] bg-[var(--color-thead)] px-4 py-2.5">
                  {h}
                </th>
              ))}
              <th scope="col" className="w-10 border-b border-[var(--color-border)] bg-[var(--color-thead)]">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((p) => {
              const name = p.displayName ?? p.email;
              const active = p.status === "active";
              return (
                <tr key={p.userId} className={`group/row transition-colors hover:bg-[var(--color-surface-2)]/45 ${selected.has(p.userId) ? "bg-[var(--color-primary-soft)]/40" : ""}`}>
                  {canEdit && (
                    <td className="py-2 pl-5">
                      <input type="checkbox" className={box} checked={selected.has(p.userId)} onChange={() => onToggle(p.userId)} aria-label={`Select ${name}`} />
                    </td>
                  )}
                  <td className="max-w-[20rem] px-4 py-2.5">
                    <button type="button" onClick={() => onOpen(p.userId)} className="flex w-full min-w-0 items-center gap-3 rounded-[var(--radius-control)] text-left focus-visible:shadow-[var(--ring)] focus-visible:outline-none">
                      <Avatar p={p} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-[var(--color-text)]">{name}</span>
                        {p.displayName && <span className="block truncate text-[13px] text-[var(--color-muted)]">{p.email}</span>}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--color-text-2)]">{p.department ?? <span className="text-[var(--color-faint)]">None</span>}</td>
                  <td className="px-4 py-2.5">
                    <Badge>{roleLabel(p.role)}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {p.userCode ? (
                      <code className="rounded-md bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs tracking-wider">{p.userCode}</code>
                    ) : (
                      <span className="text-[13px] text-[var(--color-faint)]">At first print</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={active ? "success" : "neutral"}>{active ? "Active" : "Off"}</Badge>
                  </td>
                  <td className="pr-3 text-[var(--color-faint)]">
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul aria-label="People" className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] md:hidden">
        {rows.map((p) => {
          const name = p.displayName ?? p.email;
          const active = p.status === "active";
          return (
            <li key={p.userId} className={`flex items-center border-b border-[var(--color-border)] last:border-b-0 ${selected.has(p.userId) ? "bg-[var(--color-primary-soft)]/40" : ""}`}>
              {canEdit && (
                <label className="flex min-h-14 w-12 shrink-0 cursor-pointer items-center justify-center">
                  <input type="checkbox" className={box} checked={selected.has(p.userId)} onChange={() => onToggle(p.userId)} aria-label={`Select ${name}`} />
                </label>
              )}
              <button type="button" onClick={() => onOpen(p.userId)} className={`flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 pr-3 text-left ${canEdit ? "" : "pl-3"}`}>
                <Avatar p={p} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{name}</span>
                    <Badge tone={active ? "success" : "neutral"}>{active ? "Active" : "Off"}</Badge>
                  </span>
                  <span className="block truncate text-[13px] text-[var(--color-muted)]">
                    {p.department ?? "No section"} · {roleLabel(p.role)}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-faint)]" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Avatar({ p }: { p: PersonRow }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
        p.status === "active" ? "bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]" : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
      }`}
    >
      {initials(p.displayName, p.email)}
    </span>
  );
}

function BulkBar({ count, pageCount: onPage, onPick, onClear }: { count: number; pageCount: number; onPick: (m: BulkMode) => void; onClear: () => void }) {
  const btn = "shrink-0";
  return (
    <div
      role="region"
      aria-label="Actions for the people you ticked"
      className="printio-rise fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border)] bg-[var(--color-surface)] pt-3 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] shadow-[var(--shadow-pop)] md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[min(52rem,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-full md:border md:py-2.5 md:pr-3 md:pl-5"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-2 md:max-w-none md:flex-row md:items-center md:gap-3">
        <p className="shrink-0 text-sm font-medium" aria-live="polite">
          {count.toLocaleString("en-US")} selected
          <span className="font-normal text-[var(--color-muted)]"> of {onPage.toLocaleString("en-US")} on this page</span>
        </p>
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 md:flex-wrap md:justify-end md:overflow-visible md:pb-0">
          <Button type="button" variant="outline" size="sm" className={btn} onClick={() => onPick("role")}>
            Change role
          </Button>
          <Button type="button" variant="outline" size="sm" className={btn} onClick={() => onPick("section")}>
            Set section
          </Button>
          <Button type="button" variant="outline" size="sm" className={btn} onClick={() => onPick("off")}>
            Switch off
          </Button>
          <Button type="button" variant="outline" size="sm" className={btn} onClick={() => onPick("on")}>
            Switch on
          </Button>
          <Button type="button" variant="outline-danger" size="sm" className={btn} onClick={() => onPick("remove")}>
            Remove
          </Button>
          <Button type="button" variant="ghost" size="sm" className={btn} onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}
