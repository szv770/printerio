import { Clock, History, Info, UserRound } from "lucide-react";
import { EmptyState, PageHeader, ResponsiveTable, StatCard, Tabs, type TableColumn } from "@/components/ui";
import { LocalTime } from "@/app/(dashboard)/jobs/LocalTime";
import { auditActionLabel } from "@/lib/admin/reports-view";
import { reportTabs } from "@/lib/admin/tabs";
import { ActivityDetails } from "./ActivityDetails";

export interface AuditRow {
  id: string;
  createdAt: string;
  /** Who did it: a name, or "The system" for automatic actions. */
  who: string;
  /** The stored action key; shown in plain words. */
  action: string;
  details: { label: string; value: string }[];
}

export interface AuditViewProps {
  rows: AuditRow[];
  /** "Showing the latest 200 rows" when the read hit its cap, else null. */
  truncated: string | null;
}

export function AuditView({ rows, truncated }: AuditViewProps) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const people = new Set(rows.map((r) => r.who)).size;

  const columns: TableColumn<AuditRow>[] = [
    { header: "What happened", primary: true, cell: (r) => auditActionLabel(r.action) },
    { header: "Who", cell: (r) => r.who },
    { header: "When", cell: (r) => <LocalTime iso={r.createdAt} /> },
    { header: "Details", cell: (r) => <ActivityDetails items={r.details} /> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity log" description="A record of changes made by admins and the system." />
      <Tabs label="Reports" items={reportTabs("audit", true)} />

      {rows.length === 0 ? (
        <EmptyState icon={History} title="Nothing here yet" description="Changes made by admins will show up here." />
      ) : (
        <>
          <div className="-mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard label="Events" value={rows.length.toLocaleString("en-US")} icon={<History className="h-4 w-4" />} tone="cyan" />
            <StatCard
              label="Latest"
              value={<LocalTime iso={rows[0]!.createdAt} />}
              icon={<Clock className="h-4 w-4" />}
            />
            <div className="col-span-2 lg:col-span-1">
              <StatCard
                label="Most common"
                value={<span className="text-lg leading-8">{common ? auditActionLabel(common[0]) : "-"}</span>}
                note={`${people} ${people === 1 ? "person" : "people"} involved`}
                icon={<UserRound className="h-4 w-4" />}
              />
            </div>
          </div>
          {truncated && (
            <p role="status" className="flex items-center gap-2 text-[13px] text-[var(--color-warning-ink)]">
              <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
              {truncated}. Older activity is not shown.
            </p>
          )}
          <ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Activity log" />
        </>
      )}
    </div>
  );
}
