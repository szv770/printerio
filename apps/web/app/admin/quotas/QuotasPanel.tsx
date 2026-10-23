"use client";

import { useActionState, useState } from "react";
import { Gauge, Plus } from "lucide-react";
import type { Tables } from "@/lib/database.types";
import {
  Button,
  Card,
  Collapsible,
  EmptyState,
  Field,
  FieldError,
  FormError,
  FormSuccess,
  Input,
  SAVE_BAR_CLEARANCE,
  SaveBar,
  Select,
} from "@/components/ui";
import { createQuotaAction, deleteQuotaAction, type QuotaActionState } from "./actions";
import { roleLabel } from "@/lib/role-label";
import { quotaSentence, unitWord } from "@/lib/admin/rules";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialQuotaActionState: QuotaActionState = {};

type Quota = Tables<"quotas">;
interface GroupOption {
  id: string;
  name: string;
}
interface RosterEntry {
  userId: string;
  label: string;
}

export function QuotasPanel({
  quotas,
  groups,
  roster,
  canManage,
  quotaBasis = "physical_sheets",
}: {
  quotas: Quota[];
  groups: GroupOption[];
  roster: RosterEntry[];
  canManage: boolean;
  quotaBasis?: string;
}) {
  const [createState, createAction, creating] = useActionState(createQuotaAction, initialQuotaActionState);
  const [scopeType, setScopeType] = useState("organization");

  const unit = unitWord(quotaBasis);
  const names = {
    groupName: (id: string) => groups.find((g) => g.id === id)?.name,
    userName: (id: string) => roster.find((r) => r.userId === id)?.label,
  };

  // One SaveBar for every limit on the page (same shape as the print rules page).
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const baselineOf = (q: Quota) => saved[q.id] ?? q.limit_value;
  const draftText = (q: Quota) => drafts[q.id] ?? String(baselineOf(q));
  const changed = quotas.filter((q) => draftText(q).trim() !== String(baselineOf(q)));

  function edit(q: Quota, text: string) {
    setDrafts((d) => ({ ...d, [q.id]: text.replace(/\D/g, "") }));
    setErrors((e) => {
      if (!(q.id in e)) return e;
      const copy = { ...e };
      delete copy[q.id];
      return copy;
    });
  }

  async function save() {
    if (saving || changed.length === 0) return;
    setSaving(true);
    setErrors({});
    const nextErrors: Record<string, string> = {};
    const nextSaved = { ...saved };
    const nextDrafts = { ...drafts };
    for (const q of changed) {
      const n = Number.parseInt(draftText(q), 10);
      if (!Number.isFinite(n) || n <= 0) {
        nextErrors[q.id] = "Enter a whole number above 0.";
        continue;
      }
      const fd = new FormData();
      fd.set("scopeType", q.scope_type);
      fd.set("scopeValue", q.scope_value ?? "");
      fd.set("limitValue", String(n));
      try {
        const res = await createQuotaAction({}, fd);
        if (res.error) nextErrors[q.id] = res.error;
        else {
          nextSaved[q.id] = n;
          delete nextDrafts[q.id];
        }
      } catch {
        nextErrors[q.id] = "Couldn't save. Check your connection and try again.";
      }
    }
    setSaved(nextSaved);
    setDrafts(nextDrafts);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) setSavedAt((n) => (n ?? 0) + 1);
    setSaving(false);
  }

  const failed = Object.keys(errors).length;
  const barError =
    failed > 0
      ? failed === 1
        ? "One limit couldn't be saved. The others were saved."
        : `${failed} limits couldn't be saved. The others were saved.`
      : null;

  return (
    <div className={`flex flex-col gap-6 ${canManage ? SAVE_BAR_CLEARANCE : ""}`} data-tour="admin-quotas-panel">
      {!canManage && (
        <p className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-[var(--color-text-2)]">
          You can look at these limits, but only an admin can change them.
        </p>
      )}

      {quotas.length === 0 ? (
        <EmptyState icon={Gauge} title="No monthly limits" description="Everyone can print as much as they like." />
      ) : (
        <ul className="flex flex-col gap-3">
          {quotas.map((q) => (
            <QuotaRow
              key={q.id}
              quota={q}
              who={quotaSentence(q, names)}
              unit={unit}
              text={draftText(q)}
              onChange={(t) => edit(q, t)}
              error={errors[q.id]}
              canManage={canManage}
              disabled={saving}
            />
          ))}
        </ul>
      )}

      {canManage && (
        <Collapsible id="add-limit" title="Add a limit" summary="Set how much someone can print each month" icon={<Plus className="h-4 w-4" />}>
          <form action={createAction} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Who is it for?" htmlFor="scopeType">
                <Select id="scopeType" name="scopeType" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
                  <option value="organization">Everyone</option>
                  <option value="role">A kind of person</option>
                  <option value="department">A department</option>
                  <option value="group">A group</option>
                  <option value="user">One person</option>
                </Select>
              </Field>

              {scopeType === "role" && (
                <Field label="Kind of person" htmlFor="scopeValueRole">
                  <Select id="scopeValueRole" name="scopeValue">
                    <option value="student">{roleLabel("student")}s</option>
                    <option value="staff">{roleLabel("staff")}</option>
                    <option value="approver">{roleLabel("approver")}s</option>
                    <option value="org_admin">{roleLabel("org_admin")}s</option>
                  </Select>
                </Field>
              )}
              {scopeType === "department" && (
                <Field label="Department" htmlFor="scopeValueDept">
                  <Input id="scopeValueDept" name="scopeValue" placeholder="Science" required />
                </Field>
              )}
              {scopeType === "group" && (
                <Field label="Group" htmlFor="scopeValueGroup">
                  <Select id="scopeValueGroup" name="scopeValue" required>
                    {groups.length === 0 && <option value="">No groups yet</option>}
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {scopeType === "user" && (
                <Field label="Person" htmlFor="scopeValueUser">
                  <Select id="scopeValueUser" name="scopeValue" required>
                    {roster.map((r) => (
                      <option key={r.userId} value={r.userId}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              <Field label={`${unit.charAt(0).toUpperCase()}${unit.slice(1)} a month`} htmlFor="limitValue">
                <Input id="limitValue" name="limitValue" type="number" inputMode="numeric" min={1} step={1} required placeholder="500" />
              </Field>
            </div>
            <p className="text-[13px] text-[var(--color-muted)]">
              Adding a limit for someone who already has one replaces it. If a person fits more than one limit, the lowest one applies.
            </p>
            <FormError message={createState.error} />
            <FormSuccess message={createState.success} />
            <div>
              <Button type="submit" pending={creating} pendingLabel="Adding...">
                Add limit
              </Button>
            </div>
          </form>
        </Collapsible>
      )}

      {canManage && (
        <SaveBar
          dirty={changed.length > 0}
          saving={saving}
          savedAt={savedAt}
          error={barError}
          onSave={() => void save()}
          onDiscard={() => {
            setDrafts({});
            setErrors({});
          }}
        />
      )}
    </div>
  );
}

function QuotaRow({
  quota,
  who,
  unit,
  text,
  onChange,
  error,
  canManage,
  disabled,
}: {
  quota: Quota;
  who: string;
  unit: string;
  text: string;
  onChange: (text: string) => void;
  error?: string;
  canManage: boolean;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(deleteQuotaAction, initialQuotaActionState);
  const [confirming, setConfirming] = useState(false);

  return (
    <li>
      <Card className="p-4 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-base leading-6 font-semibold">{who}</p>
            <p className="text-[13px] text-[var(--color-muted)]">can print up to</p>
          </div>
          <div className="flex items-center gap-3">
            {canManage ? (
              <Input
                aria-label={`Monthly limit for ${who}`}
                inputMode="numeric"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                invalid={!!error}
                disabled={disabled}
                className="w-28 text-right tabular-nums"
              />
            ) : (
              <span className="text-xl font-bold tabular-nums">{quota.limit_value.toLocaleString("en-US")}</span>
            )}
            <span className="text-sm text-[var(--color-text-2)]">{unit} a month</span>
          </div>
        </div>
        <FieldError message={error} />
        {canManage && (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
            {confirming ? (
              <form action={action} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="quotaId" value={quota.id} />
                <span className="text-sm text-[var(--color-text-2)]">Remove this limit?</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
                <Button type="submit" variant="danger" size="sm" pending={pending} pendingLabel="Removing...">
                  Remove
                </Button>
              </form>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
          </div>
        )}
        <FormError message={state.error} />
      </Card>
    </li>
  );
}
