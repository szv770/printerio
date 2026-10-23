import { Layers, Printer } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import type { AccessOutcome, MemberAccess } from "@/lib/admin/member-access";

const OUTCOME_UI: Record<AccessOutcome, { label: string; tone: "success" | "warning" | "danger" }> = {
  allowed: { label: "Can print", tone: "success" },
  approval: { label: "Needs approval", tone: "warning" },
  blocked: { label: "Cannot print", tone: "danger" },
};

/** "What they can use": groups and the effective result per printer, in plain words. `access` null = rules not visible to this viewer. */
export function MemberAccessCard({ groups, access, firstName }: { groups: string[]; access: MemberAccess | null; firstName: string }) {
  return (
    <Card className="mb-4 flex flex-col gap-5">
      <section aria-labelledby="member-groups">
        <h2 id="member-groups" className="mb-2 flex items-center gap-2 text-[15px] font-semibold">
          <Layers className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
          Groups
        </h2>
        {groups.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{firstName} is not in any group.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <li key={g}>
                <Badge tone="accent">{g}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="member-printers">
        <h2 id="member-printers" className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
          <Printer className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
          Printers {firstName} can use
        </h2>
        {access === null ? (
          <p className="text-sm text-[var(--color-muted)]">Only administrators can see which printers each person can use.</p>
        ) : access.printers.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">No printers have been added yet.</p>
        ) : (
          <>
            <p className="mb-3 text-[13px] text-[var(--color-muted)]">
              {access.jobDependent
                ? "This is the result for a normal one-page black and white print. Some of your rules look at the job itself (pages, colour or time), so a bigger job can get a different answer."
                : "Worked out from your print rules for this person's role, department and groups."}
            </p>
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {access.printers.map((p) => {
                const ui = OUTCOME_UI[p.outcome];
                return (
                  <li key={p.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{p.why}</p>
                    </div>
                    <span className="shrink-0">
                      <Badge tone={ui.tone}>{ui.label}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </Card>
  );
}
