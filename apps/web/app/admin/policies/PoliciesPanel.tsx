"use client";

import { useActionState, useState } from "react";
import type { Tables } from "@/lib/database.types";
import {
  createPolicyAction,
  createPolicyRuleAction,
  toggleRuleEnabledAction,
  initialPolicyActionState,
} from "./actions";

type Policy = Tables<"print_policies">;
type Rule = Tables<"policy_rules">;

export function PoliciesPanel({ policies, rules, canManage }: { policies: Policy[]; rules: Rule[]; canManage: boolean }) {
  const [createState, createAction, creating] = useActionState(createPolicyAction, initialPolicyActionState);

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <form action={createAction} className="flex items-end gap-3 rounded-lg border border-[var(--color-border)] p-4">
          <div>
            <label className="mb-1 block text-xs font-medium">New policy name</label>
            <input name="name" required placeholder="Staff Policy" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={creating} className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-white disabled:opacity-60">
            {creating ? "Creating..." : "Create policy"}
          </button>
          {createState.error && <p className="text-sm text-[var(--color-danger)]">{createState.error}</p>}
        </form>
      )}

      {policies.map((policy) => (
        <PolicyCard key={policy.id} policy={policy} rules={rules.filter((r) => r.policy_id === policy.id)} canManage={canManage} />
      ))}
      {policies.length === 0 && <p className="text-sm text-[var(--color-muted)]">No policies yet - the organization default action applies to every job.</p>}
    </div>
  );
}

function PolicyCard({ policy, rules, canManage }: { policy: Policy; rules: Rule[]; canManage: boolean }) {
  const [showNewRule, setShowNewRule] = useState(false);
  const [ruleState, ruleAction, rulePending] = useActionState(createPolicyRuleAction, initialPolicyActionState);
  const [toggleState, toggleAction] = useActionState(toggleRuleEnabledAction, initialPolicyActionState);

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">{policy.name}</p>
        {canManage && (
          <button type="button" onClick={() => setShowNewRule((v) => !v)} className="text-xs font-medium text-[var(--color-primary)]">
            + Add rule
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {rules.map((rule) => (
          <li key={rule.id} className="rounded bg-gray-50 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium uppercase">{rule.action}</span>
              {canManage && (
                <form action={toggleAction}>
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="enabled" value={String(rule.enabled)} />
                  <button type="submit" className="text-xs text-[var(--color-muted)] underline">
                    {rule.enabled ? "disable" : "enable"}
                  </button>
                </form>
              )}
            </div>
            <p>{rule.reason_label}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-xs">{JSON.stringify(rule.conditions)}</pre>
          </li>
        ))}
        {rules.length === 0 && <p className="text-xs text-[var(--color-muted)]">No rules in this policy.</p>}
      </ul>
      {toggleState.error && <p className="mt-2 text-xs text-[var(--color-danger)]">{toggleState.error}</p>}

      {showNewRule && (
        <form action={ruleAction} className="mt-3 flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3 text-sm">
          <input type="hidden" name="policyId" value={policy.id} />
          <select name="action" className="rounded border border-[var(--color-border)] px-2 py-1.5">
            <option value="require_approval">require_approval</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
          <input name="reasonLabel" placeholder="Reason shown to approvers/users" required className="rounded border border-[var(--color-border)] px-2 py-1.5" />
          <input name="priority" type="number" defaultValue={100} className="rounded border border-[var(--color-border)] px-2 py-1.5" />
          <textarea
            name="conditions"
            rows={3}
            defaultValue='[{"field":"page_count","operator":"gt","value":20}]'
            className="rounded border border-[var(--color-border)] px-2 py-1.5 font-mono text-xs"
          />
          <button type="submit" disabled={rulePending} className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-white disabled:opacity-60">
            {rulePending ? "Saving..." : "Add rule"}
          </button>
          {ruleState.error && <p className="text-[var(--color-danger)]">{ruleState.error}</p>}
        </form>
      )}
    </div>
  );
}
