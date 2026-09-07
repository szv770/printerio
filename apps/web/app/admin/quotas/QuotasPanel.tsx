"use client";

import { useActionState, useState } from "react";
import { Info } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import { Button, Input, Select, FieldLabel, FormError, FormSuccess, Badge, EmptyState, Card } from "@/components/ui";
import { createQuotaAction, deleteQuotaAction, initialQuotaActionState } from "./actions";

type Quota = Tables<"quotas">;
interface GroupOption {
  id: string;
  name: string;
}
interface RosterEntry {
  userId: string;
  label: string;
}

const SCOPE_LABEL: Record<string, string> = {
  organization: "Entire organization",
  role: "Role",
  department: "Department",
  group: "Group",
  user: "Individual user",
};

export function QuotasPanel({
  quotas,
  groups,
  roster,
  canManage,
}: {
  quotas: Quota[];
  groups: GroupOption[];
  roster: RosterEntry[];
  canManage: boolean;
}) {
  const [createState, createAction, creating] = useActionState(createQuotaAction, initialQuotaActionState);
  const [deleteState, deleteAction] = useActionState(deleteQuotaAction, initialQuotaActionState);
  const [scopeType, setScopeType] = useState("organization");

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const memberLabel = (id: string) => roster.find((r) => r.userId === id)?.label ?? id;

  function describe(q: Quota): string {
    if (q.scope_type === "organization") return "Entire organization";
    if (q.scope_type === "group" && q.scope_value) return `Group: ${groupName(q.scope_value)}`;
    if (q.scope_type === "user" && q.scope_value) return `User: ${memberLabel(q.scope_value)}`;
    return `${SCOPE_LABEL[q.scope_type] ?? q.scope_type}: ${q.scope_value ?? ""}`;
  }

  return (
    <div className="flex flex-col gap-6" data-tour="admin-quotas-panel">
      {canManage && (
        <Card>
          <form action={createAction} className="flex flex-wrap items-end gap-3">
            <div>
              <FieldLabel htmlFor="scopeType">Scope</FieldLabel>
              <Select
                id="scopeType"
                name="scopeType"
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value)}
              >
                <option value="organization">Entire organization</option>
                <option value="role">Role</option>
                <option value="department">Department</option>
                <option value="group">Group</option>
                <option value="user">Individual user</option>
              </Select>
            </div>

            {scopeType === "role" && (
              <div>
                <FieldLabel htmlFor="scopeValueRole">Role</FieldLabel>
                <Select id="scopeValueRole" name="scopeValue">
                  <option value="student">Student</option>
                  <option value="staff">Staff</option>
                  <option value="approver">Approver</option>
                  <option value="org_admin">Org admin</option>
                </Select>
              </div>
            )}
            {scopeType === "department" && (
              <div>
                <FieldLabel htmlFor="scopeValueDept">Department</FieldLabel>
                <Input id="scopeValueDept" name="scopeValue" placeholder="Science" required />
              </div>
            )}
            {scopeType === "group" && (
              <div>
                <FieldLabel htmlFor="scopeValueGroup">Group</FieldLabel>
                <Select id="scopeValueGroup" name="scopeValue" required>
                  {groups.length === 0 && <option value="">No groups yet</option>}
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {scopeType === "user" && (
              <div>
                <FieldLabel htmlFor="scopeValueUser">Member</FieldLabel>
                <Select id="scopeValueUser" name="scopeValue" required>
                  {roster.map((r) => (
                    <option key={r.userId} value={r.userId}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div>
              <FieldLabel htmlFor="limitValue">Monthly limit</FieldLabel>
              <Input id="limitValue" name="limitValue" type="number" min={1} step={1} required className="w-28" />
            </div>

            <Button type="submit" size="sm" pending={creating} pendingLabel="Saving...">
              Set quota
            </Button>
            <div className="basis-full">
              <FormError message={createState.error} />
              <FormSuccess message={createState.success} />
            </div>
          </form>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            One limit per scope: setting a limit for a scope that already has one replaces it. When someone matches
            more than one scope (their role and their department, say), the lowest of those limits is the one that
            applies.
          </p>
        </Card>
      )}

      <ul className="flex flex-col gap-2">
        {quotas.map((q) => (
          <li
            key={q.id}
            className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm"
          >
            <div className="flex items-center gap-3">
              <Badge>{describe(q)}</Badge>
              <span className="text-[var(--color-muted)]">{q.limit_value.toLocaleString()} / month</span>
            </div>
            {canManage && (
              <form action={deleteAction}>
                <input type="hidden" name="quotaId" value={q.id} />
                <button type="submit" className="text-xs text-[var(--color-danger)] underline">
                  remove
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <FormError message={deleteState.error} />
      {quotas.length === 0 && (
        <EmptyState message="No quotas configured yet - everyone can print without limit." icon={Info} />
      )}
    </div>
  );
}
